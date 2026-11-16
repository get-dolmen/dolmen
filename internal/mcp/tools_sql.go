package mcp

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"dolmen/internal/conn"
	"dolmen/internal/driver"
	"dolmen/internal/history"
	"dolmen/internal/query"
	"dolmen/internal/sqlsplit"
)

const (
	defaultQueryRows = 100
	maxQueryRows     = 1000
)

type queryArgs struct {
	targetArgs
	SQL     string `json:"sql"`
	MaxRows int    `json:"maxRows"`
}

type resultColumn struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

type statementResult struct {
	Statement    string         `json:"statement"`
	Columns      []resultColumn `json:"columns,omitempty"`
	Rows         [][]any        `json:"rows,omitempty"`
	RowsAffected int64          `json:"rowsAffected"`
	Truncated    bool           `json:"truncated,omitempty"`
	DurationMs   int64          `json:"durationMs"`
	Error        string         `json:"error,omitempty"`
}

type queryResult struct {
	Database  string            `json:"database,omitempty"`
	Committed bool              `json:"committed,omitempty"`
	Results   []statementResult `json:"results"`
}

// querier runs statements on a dedicated connection or transaction.
type querier interface {
	QueryContext(ctx context.Context, q string, args ...any) (*sql.Rows, error)
	ExecContext(ctx context.Context, q string, args ...any) (sql.Result, error)
}

func (t *Tools) readQuery(ctx context.Context, cfg Config, args queryArgs) (queryResult, error) {
	tg, dialect, stmts, err := t.statements(ctx, args.Connection, args.Database, args.SQL)
	if err != nil {
		return queryResult{}, err
	}
	for _, st := range stmts {
		if err := sqlsplit.CheckReadOnly(dialect, st.Text); err != nil {
			return queryResult{}, fmt.Errorf("%s: %w", st.Text, err)
		}
	}
	if err := t.checkSchemas(ctx, cfg, tg, dialect, stmts); err != nil {
		return queryResult{}, err
	}
	if err := t.checkDefaultSchema(ctx, cfg, tg); err != nil {
		return queryResult{}, err
	}

	maxRows := args.MaxRows
	if maxRows <= 0 {
		maxRows = defaultQueryRows
	}
	maxRows = min(maxRows, maxQueryRows)

	out := queryResult{Database: tg.database, Results: []statementResult{}}
	err = t.withReadOnly(ctx, tg.open, func(ctx context.Context, q querier) error {
		reset, err := pinSearchPath(ctx, q, tg.open, cfg.Normalize().Schemas)
		if err != nil {
			return err
		}
		defer reset()
		for _, st := range stmts {
			res := runStatement(ctx, q, dialect, st.Text, maxRows)
			t.record(tg.cfg.ID, res)
			out.Results = append(out.Results, res)
			if res.Error != "" {
				break
			}
		}
		return nil
	})
	if err != nil {
		return queryResult{}, err
	}
	return out, nil
}

func (t *Tools) writeQuery(ctx context.Context, cfg Config, args queryArgs) (queryResult, error) {
	tg, dialect, stmts, err := t.statements(ctx, args.Connection, args.Database, args.SQL)
	if err != nil {
		return queryResult{}, err
	}
	for _, st := range stmts {
		if ctl := sqlsplit.TxControl(dialect, st.Text); ctl != "" {
			return queryResult{}, fmt.Errorf("%s: transaction control is not allowed; every write_query call is its own transaction", st.Text)
		}
	}
	if err := t.checkSchemas(ctx, cfg, tg, dialect, stmts); err != nil {
		return queryResult{}, err
	}
	if err := t.checkDefaultSchema(ctx, cfg, tg); err != nil {
		return queryResult{}, err
	}

	out := queryResult{Database: tg.database, Results: []statementResult{}}
	c, err := tg.open.DB.Conn(ctx)
	if err != nil {
		return queryResult{}, err
	}
	defer c.Close()
	// Pin the session's search path before opening the transaction, and undo
	// it when the connection goes back to the shared pool.
	reset, err := pinSearchPath(ctx, c, tg.open, cfg.Normalize().Schemas)
	if err != nil {
		return queryResult{}, err
	}
	defer reset()
	tx, err := c.BeginTx(ctx, nil)
	if err != nil {
		return queryResult{}, err
	}
	committed := false
	defer func() {
		if !committed {
			tx.Rollback()
		}
	}()
	for _, st := range stmts {
		res := runStatement(ctx, tx, dialect, st.Text, defaultQueryRows)
		t.record(tg.cfg.ID, res)
		out.Results = append(out.Results, res)
		if res.Error != "" {
			return out, nil // rolled back by the deferred call
		}
	}
	if err := tx.Commit(); err != nil {
		return queryResult{}, err
	}
	committed = true
	out.Committed = true
	return out, nil
}

func (t *Tools) statements(ctx context.Context, connection, database, sqlText string) (*target, sqlsplit.Dialect, []sqlsplit.Statement, error) {
	if strings.TrimSpace(sqlText) == "" {
		return nil, "", nil, errors.New("sql is required")
	}
	tg, err := t.target(ctx, connection, database)
	if err != nil {
		return nil, "", nil, err
	}
	dialect := sqlsplit.Dialect(tg.cfg.Kind)
	stmts := sqlsplit.Split(dialect, sqlText)
	if len(stmts) == 0 {
		return nil, "", nil, errors.New("no SQL statement found")
	}
	return tg, dialect, stmts, nil
}

// checkSchemas rejects explicit references to known schemas outside the
// allow-list. The session's search path is pinned separately, so unqualified
// names cannot reach them through the server's defaults either.
func (t *Tools) checkSchemas(ctx context.Context, cfg Config, tg *target, dialect sqlsplit.Dialect, stmts []sqlsplit.Statement) error {
	allowed := cfg.Normalize().Schemas
	if len(allowed) == 0 {
		return nil
	}
	known, err := tg.open.Driver.ListSchemas(ctx, tg.open.DB)
	if err != nil {
		return err
	}
	isKnown := make(map[string]bool, len(known))
	for _, schema := range known {
		isKnown[strings.ToLower(schema)] = true
	}
	for _, st := range stmts {
		for _, ref := range sqlsplit.References(dialect, st.Text) {
			name := strings.ToLower(ref.Schema)
			if isKnown[name] && !containsName(allowed, ref.Schema) {
				return fmt.Errorf("schema %q is not allowed by the MCP permissions", ref.Schema)
			}
		}
	}
	return nil
}

// checkDefaultSchema closes the hole unqualified names would otherwise leave:
// on engines where the session's default schema cannot be swapped for an
// allowed one, running SQL would still reach it. Postgres gets its search
// path pinned and MySQL's default database is already checked.
func (t *Tools) checkDefaultSchema(ctx context.Context, cfg Config, tg *target) error {
	allowed := cfg.Normalize().Schemas
	if len(allowed) == 0 || tg.cfg.Kind == driver.Postgres || tg.cfg.Kind == driver.MySQL {
		return nil
	}
	def, err := tg.open.Driver.DefaultSchema(ctx, tg.open.DB)
	if err != nil {
		return err
	}
	if !cfg.AllowsSchema(def) {
		return fmt.Errorf("the connection's default schema %q is not allowed; add it to the schema allow-list", def)
	}
	return nil
}

// withReadOnly runs fn on a dedicated connection with the engine's read-only
// protection on top of the statement guard.
func (t *Tools) withReadOnly(ctx context.Context, o *conn.Open, fn func(context.Context, querier) error) error {
	c, err := o.DB.Conn(ctx)
	if err != nil {
		return err
	}
	defer c.Close()
	if o.Config.Kind == driver.Oracle {
		tx, err := c.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		if _, err := tx.ExecContext(ctx, o.Driver.ReadOnlyTxStatement()); err != nil {
			return err
		}
		return fn(ctx, tx)
	}
	if stmt, reset := readOnlySession(o.Config.Kind); stmt != "" {
		if _, err := c.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("could not make the session read-only: %w", err)
		}
		defer c.ExecContext(context.Background(), reset)
	}
	return fn(ctx, c)
}

// readOnlySession returns the statements that make one connection read-only,
// and the matching reset so the connection can go back to the pool.
func readOnlySession(kind driver.Kind) (on, off string) {
	switch kind {
	case driver.Postgres:
		return "SET default_transaction_read_only = on", "SET default_transaction_read_only = off"
	case driver.MySQL:
		return "SET SESSION transaction_read_only = ON", "SET SESSION transaction_read_only = OFF"
	case driver.SQLite:
		return "PRAGMA query_only = ON", "PRAGMA query_only = OFF"
	}
	return "", ""
}

// pinSearchPath keeps unqualified table names inside the allowed schemas on
// Postgres, where the server's default search_path would otherwise expose
// schemas the policy hides. The returned function restores the default path
// before the connection rejoins the shared pool.
func pinSearchPath(ctx context.Context, q querier, o *conn.Open, schemas []string) (func(), error) {
	noop := func() {}
	if len(schemas) == 0 || o.Config.Kind != driver.Postgres {
		return noop, nil
	}
	quoted := make([]string, len(schemas))
	for i, schema := range schemas {
		quoted[i] = o.Driver.QuoteIdent(schema)
	}
	if _, err := q.ExecContext(ctx, "SET search_path TO "+strings.Join(quoted, ", ")); err != nil {
		return noop, err
	}
	return func() {
		_, _ = q.ExecContext(context.Background(), "SET search_path TO DEFAULT")
	}, nil
}

func runStatement(ctx context.Context, q querier, d sqlsplit.Dialect, stmt string, maxRows int) (res statementResult) {
	res = statementResult{Statement: stmt, RowsAffected: -1}
	start := time.Now()
	defer func() { res.DurationMs = time.Since(start).Milliseconds() }()

	if !sqlsplit.ReturnsRows(d, stmt) {
		r, err := q.ExecContext(ctx, stmt)
		if err != nil {
			res.Error = err.Error()
			return res
		}
		if n, err := r.RowsAffected(); err == nil {
			res.RowsAffected = n
		}
		return res
	}

	rows, err := q.QueryContext(ctx, stmt)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	defer rows.Close()
	types, err := rows.ColumnTypes()
	if err != nil {
		res.Error = err.Error()
		return res
	}
	for _, typ := range types {
		res.Columns = append(res.Columns, resultColumn{Name: typ.Name(), Type: typ.DatabaseTypeName()})
	}
	res.Rows = [][]any{}
	for len(res.Rows) < maxRows {
		if !rows.Next() {
			if err := rows.Err(); err != nil {
				res.Error = err.Error()
			}
			return res
		}
		row, err := query.ScanRow(rows, len(types))
		if err != nil {
			res.Error = err.Error()
			return res
		}
		res.Rows = append(res.Rows, row)
	}
	// One more row means the output was cut; the discarded row is not read
	// again because read_query never resumes a result.
	if rows.Next() {
		res.Truncated = true
	} else if err := rows.Err(); err != nil {
		res.Error = err.Error()
	}
	return res
}

func (t *Tools) record(connID string, res statementResult) {
	if t.hist == nil {
		return
	}
	status := "ok"
	if res.Error != "" {
		status = "error"
	}
	n := res.RowsAffected
	if len(res.Columns) > 0 {
		n = int64(len(res.Rows))
	}
	now := time.Now().UnixMilli()
	t.hist.Record(history.Entry{
		ConnID:     connID,
		SQL:        res.Statement,
		StartedAt:  now - res.DurationMs,
		DurationMs: res.DurationMs,
		Rows:       n,
		Status:     status,
		Error:      res.Error,
	})
}
