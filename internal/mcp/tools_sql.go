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

type queryArguments struct {
	targetArguments
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
	QueryContext(ctx context.Context, query string, arguments ...any) (*sql.Rows, error)
	ExecContext(ctx context.Context, query string, arguments ...any) (sql.Result, error)
}

func (t *Tools) readQuery(ctx context.Context, config Config, arguments queryArguments) (queryResult, error) {
	connection, dialect, statements, err := t.statements(ctx, arguments.Connection, arguments.Database, arguments.SQL)
	if err != nil {
		return queryResult{}, err
	}
	for _, statement := range statements {
		if err := sqlsplit.CheckReadOnly(dialect, statement.Text); err != nil {
			return queryResult{}, fmt.Errorf("%s: %w", statement.Text, err)
		}
	}
	if err := t.checkSchemas(ctx, config, connection, dialect, statements); err != nil {
		return queryResult{}, err
	}
	if err := t.checkDefaultSchema(ctx, config, connection); err != nil {
		return queryResult{}, err
	}

	maxRows := arguments.MaxRows
	if maxRows <= 0 {
		maxRows = defaultQueryRows
	}
	maxRows = min(maxRows, maxQueryRows)

	output := queryResult{Database: connection.database, Results: []statementResult{}}
	err = t.withReadOnly(ctx, connection.opened, func(ctx context.Context, runner querier) error {
		reset, err := pinSearchPath(ctx, runner, connection.opened, config.Normalize().Schemas)
		if err != nil {
			return err
		}
		defer reset()
		for _, statement := range statements {
			result := runStatement(ctx, runner, dialect, statement.Text, maxRows)
			t.record(connection.config.ID, result)
			output.Results = append(output.Results, result)
			if result.Error != "" {
				break
			}
		}
		return nil
	})
	if err != nil {
		return queryResult{}, err
	}
	return output, nil
}

func (t *Tools) writeQuery(ctx context.Context, config Config, arguments queryArguments) (queryResult, error) {
	connection, dialect, statements, err := t.statements(ctx, arguments.Connection, arguments.Database, arguments.SQL)
	if err != nil {
		return queryResult{}, err
	}
	for _, statement := range statements {
		if control := sqlsplit.TxControl(dialect, statement.Text); control != "" {
			return queryResult{}, fmt.Errorf("%s: transaction control is not allowed; every write_query call is its own transaction", statement.Text)
		}
	}
	if err := t.checkSchemas(ctx, config, connection, dialect, statements); err != nil {
		return queryResult{}, err
	}
	if err := t.checkDefaultSchema(ctx, config, connection); err != nil {
		return queryResult{}, err
	}

	output := queryResult{Database: connection.database, Results: []statementResult{}}
	session, err := connection.opened.DB.Conn(ctx)
	if err != nil {
		return queryResult{}, err
	}
	defer session.Close()
	// Pin the session's search path before opening the transaction, and undo
	// it when the connection goes back to the shared pool.
	reset, err := pinSearchPath(ctx, session, connection.opened, config.Normalize().Schemas)
	if err != nil {
		return queryResult{}, err
	}
	defer reset()
	tx, err := session.BeginTx(ctx, nil)
	if err != nil {
		return queryResult{}, err
	}
	committed := false
	defer func() {
		if !committed {
			tx.Rollback()
		}
	}()
	for _, statement := range statements {
		result := runStatement(ctx, tx, dialect, statement.Text, defaultQueryRows)
		t.record(connection.config.ID, result)
		output.Results = append(output.Results, result)
		if result.Error != "" {
			return output, nil // rolled back by the deferred call
		}
	}
	if err := tx.Commit(); err != nil {
		return queryResult{}, err
	}
	committed = true
	output.Committed = true
	return output, nil
}

func (t *Tools) statements(ctx context.Context, connectionRef, database, sqlText string) (*target, sqlsplit.Dialect, []sqlsplit.Statement, error) {
	if strings.TrimSpace(sqlText) == "" {
		return nil, "", nil, errors.New("sql is required")
	}
	connection, err := t.target(ctx, connectionRef, database)
	if err != nil {
		return nil, "", nil, err
	}
	dialect := sqlsplit.Dialect(connection.config.Kind)
	statements := sqlsplit.Split(dialect, sqlText)
	if len(statements) == 0 {
		return nil, "", nil, errors.New("no SQL statement found")
	}
	return connection, dialect, statements, nil
}

// checkSchemas rejects explicit references to known schemas outside the
// allow-list. The session's search path is pinned separately, so unqualified
// names cannot reach them through the server's defaults either.
func (t *Tools) checkSchemas(ctx context.Context, config Config, connection *target, dialect sqlsplit.Dialect, statements []sqlsplit.Statement) error {
	allowed := config.Normalize().Schemas
	if len(allowed) == 0 {
		return nil
	}
	known, err := connection.opened.Driver.ListSchemas(ctx, connection.opened.DB)
	if err != nil {
		return err
	}
	isKnown := make(map[string]bool, len(known))
	for _, schema := range known {
		isKnown[strings.ToLower(schema)] = true
	}
	for _, statement := range statements {
		for _, reference := range sqlsplit.References(dialect, statement.Text) {
			name := strings.ToLower(reference.Schema)
			if isKnown[name] && !containsName(allowed, reference.Schema) {
				return fmt.Errorf("schema %q is not allowed by the MCP permissions", reference.Schema)
			}
		}
	}
	return nil
}

// checkDefaultSchema closes the hole unqualified names would otherwise leave:
// on engines where the session's default schema cannot be swapped for an
// allowed one, running SQL would still reach it. Postgres gets its search
// path pinned and MySQL's default database is already checked.
func (t *Tools) checkDefaultSchema(ctx context.Context, config Config, connection *target) error {
	allowed := config.Normalize().Schemas
	if len(allowed) == 0 || connection.config.Kind == driver.Postgres || connection.config.Kind == driver.MySQL {
		return nil
	}
	defaultSchema, err := connection.opened.Driver.DefaultSchema(ctx, connection.opened.DB)
	if err != nil {
		return err
	}
	if !config.AllowsSchema(defaultSchema) {
		return fmt.Errorf("the connection's default schema %q is not allowed; add it to the schema allow-list", defaultSchema)
	}
	return nil
}

// withReadOnly runs operation on a dedicated connection with the engine's read-only
// protection on top of the statement guard.
func (t *Tools) withReadOnly(ctx context.Context, opened *conn.Open, operation func(context.Context, querier) error) error {
	session, err := opened.DB.Conn(ctx)
	if err != nil {
		return err
	}
	defer session.Close()
	if opened.Config.Kind == driver.Oracle {
		tx, err := session.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		if _, err := tx.ExecContext(ctx, opened.Driver.ReadOnlyTxStatement()); err != nil {
			return err
		}
		return operation(ctx, tx)
	}
	if readOnlyStatement, reset := readOnlySession(opened.Config.Kind); readOnlyStatement != "" {
		if _, err := session.ExecContext(ctx, readOnlyStatement); err != nil {
			return fmt.Errorf("could not make the session read-only: %w", err)
		}
		defer session.ExecContext(context.Background(), reset)
	}
	return operation(ctx, session)
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
func pinSearchPath(ctx context.Context, runner querier, opened *conn.Open, schemas []string) (func(), error) {
	noop := func() {}
	if len(schemas) == 0 || opened.Config.Kind != driver.Postgres {
		return noop, nil
	}
	quoted := make([]string, len(schemas))
	for i, schema := range schemas {
		quoted[i] = opened.Driver.QuoteIdent(schema)
	}
	if _, err := runner.ExecContext(ctx, "SET search_path TO "+strings.Join(quoted, ", ")); err != nil {
		return noop, err
	}
	return func() {
		_, _ = runner.ExecContext(context.Background(), "SET search_path TO DEFAULT")
	}, nil
}

func runStatement(ctx context.Context, runner querier, dialect sqlsplit.Dialect, statement string, maxRows int) (result statementResult) {
	result = statementResult{Statement: statement, RowsAffected: -1}
	start := time.Now()
	defer func() { result.DurationMs = time.Since(start).Milliseconds() }()

	if !sqlsplit.ReturnsRows(dialect, statement) {
		execution, err := runner.ExecContext(ctx, statement)
		if err != nil {
			result.Error = err.Error()
			return result
		}
		if rowCount, err := execution.RowsAffected(); err == nil {
			result.RowsAffected = rowCount
		}
		return result
	}

	rows, err := runner.QueryContext(ctx, statement)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	defer rows.Close()
	columnTypes, err := rows.ColumnTypes()
	if err != nil {
		result.Error = err.Error()
		return result
	}
	for _, columnType := range columnTypes {
		result.Columns = append(result.Columns, resultColumn{Name: columnType.Name(), Type: columnType.DatabaseTypeName()})
	}
	result.Rows = [][]any{}
	for len(result.Rows) < maxRows {
		if !rows.Next() {
			if err := rows.Err(); err != nil {
				result.Error = err.Error()
			}
			return result
		}
		row, err := query.ScanRow(rows, len(columnTypes))
		if err != nil {
			result.Error = err.Error()
			return result
		}
		result.Rows = append(result.Rows, row)
	}
	// One more row means the output was cut; the discarded row is not read
	// again because read_query never resumes a result.
	if rows.Next() {
		result.Truncated = true
	} else if err := rows.Err(); err != nil {
		result.Error = err.Error()
	}
	return result
}

func (t *Tools) record(connID string, result statementResult) {
	if t.historyStore == nil {
		return
	}
	status := "ok"
	if result.Error != "" {
		status = "error"
	}
	rowCount := result.RowsAffected
	if len(result.Columns) > 0 {
		rowCount = int64(len(result.Rows))
	}
	now := time.Now().UnixMilli()
	t.historyStore.Record(history.Entry{
		ConnID:     connID,
		SQL:        result.Statement,
		StartedAt:  now - result.DurationMs,
		DurationMs: result.DurationMs,
		Rows:       rowCount,
		Status:     status,
		Error:      result.Error,
	})
}
