// Package query runs SQL for editor tabs. Each tab gets its own database
// session, so SET statements and transactions persist across runs.
package query

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"dolmen/internal/conn"
	"dolmen/internal/history"
	"dolmen/internal/sqlsplit"
)

const DefaultMaxRows = 1000

type ExecRequest struct {
	TabID  string `json:"tabId"`
	ConnID string `json:"connId"`
	// Database selects another database of the same server (Postgres); "" = the connection's own.
	Database string `json:"database"`
	SQL      string `json:"sql"`
	// Cursor is a UTF-16 offset into SQL; the statement under it runs.
	// A negative value runs every statement.
	Cursor  int `json:"cursor"`
	MaxRows int `json:"maxRows"`
	// Manual keeps a transaction open across runs until Commit / Rollback.
	// Ignored on read-only connections.
	Manual bool `json:"manual"`
}

// TxStatus describes a tab's manual transaction.
type TxStatus struct {
	Open       bool  `json:"open"`
	Statements int   `json:"statements"` // statements run inside it
	StartedAt  int64 `json:"startedAt"`  // unix ms
}

type Column struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

type Result struct {
	ID           string   `json:"id"`
	Statement    string   `json:"statement"`
	Columns      []Column `json:"columns"`
	Rows         [][]any  `json:"rows"`
	IsQuery      bool     `json:"isQuery"`
	HasMore      bool     `json:"hasMore"`      // more rows exist on the server
	CanFetchMore bool     `json:"canFetchMore"` // the cursor is still open
	RowsAffected int64    `json:"rowsAffected"`
	// Message replaces the usual summary (e.g. "Committed").
	Message    string `json:"message,omitempty"`
	DurationMs int64  `json:"durationMs"`
	Error      string `json:"error,omitempty"`
	// End is the UTF-16 offset in the request's SQL just past the statement,
	// so the editor can show the result under it.
	End int `json:"end"`
}

type ExecResponse struct {
	Results   []Result `json:"results"`
	Cancelled bool     `json:"cancelled"`
	Tx        TxStatus `json:"tx"`
	// Notice is informational text for the Messages panel.
	Notice string `json:"notice,omitempty"`
}

type querier interface {
	QueryContext(ctx context.Context, q string, args ...any) (*sql.Rows, error)
	ExecContext(ctx context.Context, q string, args ...any) (sql.Result, error)
}

// cursor is the open result set of the last statement of a run.
type cursor struct {
	resultID string
	rows     *sql.Rows
	ncols    int
	tx       *sql.Tx
	cancel   context.CancelFunc
}

func (c *cursor) close() {
	c.rows.Close()
	if c.tx != nil {
		c.tx.Rollback()
	}
	c.cancel()
}

// cached keeps the rows already sent for each result of the last run, for export.
type cached struct {
	columns []Column
	rows    [][]any
}

type session struct {
	connID  string
	db      string
	conn    *sql.Conn
	busy    sync.Mutex // one run at a time per tab
	cancel  atomic.Pointer[context.CancelFunc]
	cursor  *cursor
	results map[string]*cached
	// Manual-mode transaction, kept across runs.
	tx      *sql.Tx
	txStmts int
	txSince time.Time
}

func (s *session) txStatus() TxStatus {
	if s.tx == nil {
		return TxStatus{}
	}
	return TxStatus{Open: true, Statements: s.txStmts, StartedAt: s.txSince.UnixMilli()}
}

// beginTx opens the manual transaction if needed. It is not bound to any
// run's context, so cancelling a statement does not end it by itself.
func (s *session) beginTx() error {
	if s.tx != nil {
		return nil
	}
	tx, err := s.conn.BeginTx(context.Background(), nil)
	if err != nil {
		return err
	}
	s.tx, s.txStmts, s.txSince = tx, 0, time.Now()
	return nil
}

func (s *session) endTx(commit bool) error {
	if s.tx == nil {
		return errors.New("no open transaction")
	}
	var err error
	if commit {
		err = s.tx.Commit()
	} else {
		err = s.tx.Rollback()
	}
	s.tx = nil
	return err
}

// reset discards the database session (and any transaction on it).
func (s *session) reset() {
	s.closeCursor()
	if s.tx != nil {
		s.tx.Rollback()
		s.tx = nil
	}
	if s.conn != nil {
		s.conn.Close()
		s.conn = nil
	}
}

func (s *session) closeCursor() {
	if s.cursor != nil {
		s.cursor.close()
		s.cursor = nil
		s.cancel.Store(nil)
	}
}

type Executor struct {
	conns   *conn.Manager
	hist    *history.Store
	mu      sync.Mutex
	tabs    map[string]*session
	counter atomic.Int64
}

func NewExecutor(m *conn.Manager, h *history.Store) *Executor {
	return &Executor{conns: m, hist: h, tabs: map[string]*session{}}
}

func (e *Executor) newID() string { return "r" + strconv.FormatInt(e.counter.Add(1), 36) }

// sessionFor returns the tab's session, replacing it when the tab switched connection or database.
func (e *Executor) sessionFor(tabID, connID, db string) *session {
	e.mu.Lock()
	defer e.mu.Unlock()
	s := e.tabs[tabID]
	if s != nil && s.connID == connID && s.db == db {
		return s
	}
	if s != nil {
		go e.dropSession(s)
	}
	s = &session{connID: connID, db: db, results: map[string]*cached{}}
	e.tabs[tabID] = s
	return s
}

func (e *Executor) dropSession(s *session) {
	if c := s.cancel.Load(); c != nil {
		(*c)()
	}
	s.busy.Lock()
	defer s.busy.Unlock()
	s.reset()
}

// CloseTab releases the tab's session.
func (e *Executor) CloseTab(tabID string) {
	e.mu.Lock()
	s := e.tabs[tabID]
	delete(e.tabs, tabID)
	e.mu.Unlock()
	if s != nil {
		e.dropSession(s)
	}
}

// CloseConnection releases every session bound to a connection.
func (e *Executor) CloseConnection(connID string) { e.closeWhere(func(s *session) bool { return s.connID == connID }) }

// CloseDatabase releases the sessions bound to one database of a connection
// (not its main one), before that database is dropped.
func (e *Executor) CloseDatabase(connID, database string) {
	e.closeWhere(func(s *session) bool { return s.connID == connID && s.db == database })
}

func (e *Executor) closeWhere(match func(*session) bool) {
	e.mu.Lock()
	var drop []*session
	for id, s := range e.tabs {
		if match(s) {
			drop = append(drop, s)
			delete(e.tabs, id)
		}
	}
	e.mu.Unlock()
	for _, s := range drop {
		e.dropSession(s)
	}
}

// Cancel stops the running statement of a tab, if any.
func (e *Executor) Cancel(tabID string) {
	e.mu.Lock()
	s := e.tabs[tabID]
	e.mu.Unlock()
	if s == nil {
		return
	}
	if c := s.cancel.Load(); c != nil {
		(*c)()
	}
}

func (e *Executor) Execute(req ExecRequest) (*ExecResponse, error) {
	main, err := e.conns.Get(req.ConnID)
	if err != nil {
		return nil, err
	}
	db := req.Database
	if db == main.CurrentDB {
		db = "" // same session key as the main pool
	}
	open, err := e.conns.GetDB(context.Background(), req.ConnID, db)
	if err != nil {
		return nil, err
	}
	dialect := sqlsplit.Dialect(open.Config.Kind)

	stmts := sqlsplit.Split(dialect, req.SQL)
	if req.Cursor >= 0 {
		st, ok := sqlsplit.AtCursor(stmts, sqlsplit.UTF16ToByteOffset(req.SQL, req.Cursor))
		stmts = nil
		if ok {
			stmts = []sqlsplit.Statement{st}
		}
	}
	if len(stmts) == 0 {
		return &ExecResponse{Results: []Result{}, Notice: "Nothing to run."}, nil
	}
	if open.Config.ReadOnly {
		for _, st := range stmts {
			if err := sqlsplit.CheckReadOnly(dialect, st.Text); err != nil {
				return &ExecResponse{Results: []Result{{ID: e.newID(), Statement: st.Text, Error: err.Error(), End: sqlsplit.ByteToUTF16Offset(req.SQL, st.End)}}}, nil
			}
		}
	}
	maxRows := req.MaxRows
	if maxRows <= 0 {
		maxRows = DefaultMaxRows
	}

	s := e.sessionFor(req.TabID, req.ConnID, db)
	if !s.busy.TryLock() {
		return nil, errors.New("a query is already running in this tab")
	}
	defer s.busy.Unlock()
	s.closeCursor()
	s.results = map[string]*cached{}

	ctx, cancel := context.WithCancel(context.Background())
	s.cancel.Store(&cancel)
	keepCtx := false // true when the last result's cursor stays open
	defer func() {
		if !keepCtx {
			s.cancel.Store(nil)
			cancel()
		}
	}()

	if s.conn == nil {
		c, err := open.DB.Conn(ctx)
		if err != nil {
			return nil, err
		}
		s.conn = c
	}

	manual := req.Manual && !open.Config.ReadOnly
	if !manual && s.tx != nil {
		return nil, errors.New("this tab has an open transaction: commit or roll back before switching to auto-commit")
	}

	var q querier = s.conn
	var tx *sql.Tx // per-run read-only transaction (Oracle), not the manual one
	if stmt := open.Driver.ReadOnlyTxStatement(); open.Config.ReadOnly && stmt != "" {
		tx, err = s.conn.BeginTx(ctx, nil)
		if err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, stmt); err != nil {
			tx.Rollback()
			return nil, err
		}
		q = tx
	}

	resp := &ExecResponse{Results: make([]Result, 0, len(stmts))}
	for i, st := range stmts {
		last := i == len(stmts)-1
		end := sqlsplit.ByteToUTF16Offset(req.SQL, st.End)
		start := time.Now()
		var res Result
		var cur *cursor
		if manual {
			// COMMIT / ROLLBACK / BEGIN typed by the user act on the tab's transaction.
			if ctl := sqlsplit.TxControl(dialect, st.Text); ctl != "" {
				res = e.txControl(s, ctl, st.Text)
				res.DurationMs = time.Since(start).Milliseconds()
				res.End = end
				resp.Results = append(resp.Results, res)
				if res.Error != "" {
					break
				}
				continue
			}
			if err := s.beginTx(); err != nil {
				resp.Results = append(resp.Results, Result{ID: e.newID(), Statement: st.Text, RowsAffected: -1, Error: err.Error(), End: end})
				break
			}
			q = s.tx
			s.txStmts++
		}
		res, cur = e.runOne(ctx, q, dialect, st.Text, maxRows, last)
		res.DurationMs = time.Since(start).Milliseconds()
		res.End = end
		resp.Results = append(resp.Results, res)
		e.record(req.ConnID, res, ctx.Err() != nil)
		if res.Error == "" && res.IsQuery {
			s.results[res.ID] = &cached{columns: res.Columns, rows: res.Rows}
		}
		if cur != nil {
			cur.tx, cur.cancel = tx, cancel
			s.cursor = cur
			keepCtx = true
		}
		if res.Error != "" {
			break
		}
	}

	if ctx.Err() != nil {
		resp.Cancelled = true
		resp.Notice = "Query cancelled. The tab's database session was reset."
		if s.tx != nil {
			resp.Notice = "Query cancelled. The tab's database session was reset and its open transaction rolled back."
		}
		keepCtx = false
		s.reset() // the driver may have left the connection unusable
	} else if !keepCtx && tx != nil {
		tx.Rollback()
	}
	if n := len(resp.Results); n > 0 && resp.Results[n-1].Error != "" && isBadConn(resp.Results[n-1].Error) {
		s.reset()
	}
	resp.Tx = s.txStatus()
	return resp, nil
}

// txControl runs a COMMIT / ROLLBACK / BEGIN typed in manual mode.
func (e *Executor) txControl(s *session, ctl, stmt string) Result {
	res := Result{ID: e.newID(), Statement: stmt, RowsAffected: -1, Rows: [][]any{}, Columns: []Column{}}
	switch ctl {
	case "begin":
		if s.tx != nil {
			res.Message = "Already in a transaction (manual mode starts one automatically)."
			return res
		}
		if err := s.beginTx(); err != nil {
			res.Error = err.Error()
			return res
		}
		res.Message = "Transaction started."
	case "commit", "rollback":
		if s.tx == nil {
			res.Message = "No open transaction."
			return res
		}
		n := s.txStmts
		if err := s.endTx(ctl == "commit"); err != nil {
			res.Error = err.Error()
			return res
		}
		verb := "Committed"
		if ctl == "rollback" {
			verb = "Rolled back"
		}
		res.Message = fmt.Sprintf("%s (%d statement%s).", verb, n, plural(n))
	}
	return res
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// EndTx commits or rolls back a tab's manual transaction.
func (e *Executor) EndTx(tabID string, commit bool) (TxStatus, error) {
	e.mu.Lock()
	s := e.tabs[tabID]
	e.mu.Unlock()
	if s == nil {
		return TxStatus{}, errors.New("no open transaction")
	}
	if !s.busy.TryLock() {
		return s.txStatus(), errors.New("a query is running in this tab")
	}
	defer s.busy.Unlock()
	s.closeCursor() // an open result set would block the commit
	err := s.endTx(commit)
	return s.txStatus(), err
}

// TxStatusOf reports a tab's manual transaction.
func (e *Executor) TxStatusOf(tabID string) TxStatus {
	e.mu.Lock()
	s := e.tabs[tabID]
	e.mu.Unlock()
	if s == nil || !s.busy.TryLock() {
		return TxStatus{}
	}
	defer s.busy.Unlock()
	return s.txStatus()
}

// Querier runs statements; *sql.Conn and *sql.Tx both satisfy it.
type Querier = querier

// WithSession runs fn on the tab's database session, so data tabs share the
// manual-transaction behaviour of SQL tabs:
//   - manual: fn runs inside the tab's open transaction (begun if needed);
//     writes are protected by a savepoint so a failed batch is undone alone;
//   - auto, write: fn runs in its own transaction, committed on success;
//   - auto, read: fn runs directly on the session.
//
// fn returns how many statements it executed (counted in the transaction).
func (e *Executor) WithSession(ctx context.Context, tabID, connID, database string, manual, write bool,
	fn func(ctx context.Context, o *conn.Open, q Querier) (int, error)) (TxStatus, error) {
	main, err := e.conns.Get(connID)
	if err != nil {
		return TxStatus{}, err
	}
	db := database
	if db == main.CurrentDB {
		db = ""
	}
	open, err := e.conns.GetDB(ctx, connID, db)
	if err != nil {
		return TxStatus{}, err
	}
	manual = manual && !open.Config.ReadOnly
	s := e.sessionFor(tabID, connID, db)
	if !s.busy.TryLock() {
		return TxStatus{}, errors.New("this tab is busy")
	}
	defer s.busy.Unlock()
	if !manual && s.tx != nil {
		return s.txStatus(), errors.New("this tab has an open transaction: commit or roll back before switching to auto-commit")
	}
	if s.conn == nil {
		if s.conn, err = open.DB.Conn(ctx); err != nil {
			return TxStatus{}, err
		}
	}

	switch {
	case manual && write:
		if err := s.beginTx(); err != nil {
			return TxStatus{}, err
		}
		if _, err := s.tx.ExecContext(ctx, "SAVEPOINT dolmen_apply"); err != nil {
			return s.txStatus(), err
		}
		n, err := fn(ctx, open, s.tx)
		if err != nil {
			s.tx.ExecContext(ctx, "ROLLBACK TO SAVEPOINT dolmen_apply")
			return s.txStatus(), err
		}
		s.txStmts += n
	case manual && s.tx != nil:
		// Reads go through the open transaction so they see its changes.
		if _, err := fn(ctx, open, s.tx); err != nil {
			return s.txStatus(), err
		}
	case write:
		tx, err := s.conn.BeginTx(ctx, nil)
		if err != nil {
			return TxStatus{}, err
		}
		defer tx.Rollback()
		if _, err := fn(ctx, open, tx); err != nil {
			return TxStatus{}, err
		}
		if err := tx.Commit(); err != nil {
			return TxStatus{}, err
		}
	default:
		if _, err := fn(ctx, open, s.conn); err != nil {
			if isBadConn(err.Error()) {
				s.reset()
			}
			return s.txStatus(), err
		}
	}
	return s.txStatus(), nil
}

func (e *Executor) runOne(ctx context.Context, q querier, d sqlsplit.Dialect, stmt string, maxRows int, last bool) (Result, *cursor) {
	res := Result{ID: e.newID(), Statement: stmt, RowsAffected: -1, Rows: [][]any{}, Columns: []Column{}}
	if !sqlsplit.ReturnsRows(d, stmt) {
		r, err := q.ExecContext(ctx, stmt)
		if err != nil {
			res.Error = errText(ctx, err)
			return res, nil
		}
		if n, err := r.RowsAffected(); err == nil {
			res.RowsAffected = n
		}
		return res, nil
	}

	rows, err := q.QueryContext(ctx, stmt)
	if err != nil {
		res.Error = errText(ctx, err)
		return res, nil
	}
	res.IsQuery = true
	types, err := rows.ColumnTypes()
	if err != nil {
		rows.Close()
		res.Error = errText(ctx, err)
		return res, nil
	}
	for _, t := range types {
		res.Columns = append(res.Columns, Column{Name: t.Name(), Type: t.DatabaseTypeName()})
	}
	res.Rows, res.HasMore, err = fetch(rows, len(types), maxRows)
	if err != nil {
		rows.Close()
		res.Error = errText(ctx, err)
		return res, nil
	}
	if res.HasMore && last {
		res.CanFetchMore = true
		return res, &cursor{resultID: res.ID, rows: rows, ncols: len(types)}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		res.Error = errText(ctx, err)
	}
	return res, nil
}

// fetch reads up to n rows; hasMore reports whether another row is pending.
func fetch(rows *sql.Rows, ncols, n int) ([][]any, bool, error) {
	out := make([][]any, 0, min(n, 256))
	for len(out) < n {
		if !rows.Next() {
			return out, false, rows.Err()
		}
		row, err := scanRow(rows, ncols)
		if err != nil {
			return out, false, err
		}
		out = append(out, row)
	}
	// Peek: Next advances, so the peeked row is read first by the next fetch.
	if !rows.Next() {
		return out, false, rows.Err()
	}
	return out, true, nil
}

func scanRow(rows *sql.Rows, ncols int) ([]any, error) {
	vals := make([]any, ncols)
	ptrs := make([]any, ncols)
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	if err := rows.Scan(ptrs...); err != nil {
		return nil, err
	}
	for i, v := range vals {
		vals[i] = Normalize(v)
	}
	return vals, nil
}

type FetchResult struct {
	Rows    [][]any `json:"rows"`
	HasMore bool    `json:"hasMore"`
	Error   string  `json:"error,omitempty"`
}

// FetchMore reads the next page of the tab's open cursor.
func (e *Executor) FetchMore(tabID, resultID string, n int) (*FetchResult, error) {
	s, cur, err := e.lockCursor(tabID, resultID)
	if err != nil {
		return nil, err
	}
	defer s.busy.Unlock()
	if n <= 0 {
		n = DefaultMaxRows
	}
	// The pending row was already advanced to by the previous peek.
	first, err := scanRow(cur.rows, cur.ncols)
	if err != nil {
		s.closeCursor()
		return &FetchResult{Rows: [][]any{}, Error: err.Error()}, nil
	}
	rest, more, err := fetch(cur.rows, cur.ncols, n-1)
	rows := append([][]any{first}, rest...)
	if c := s.results[resultID]; c != nil {
		c.rows = append(c.rows, rows...)
	}
	res := &FetchResult{Rows: rows, HasMore: more}
	if err != nil {
		res.Error = err.Error()
	}
	if !more || err != nil {
		s.closeCursor()
	}
	return res, nil
}

func (e *Executor) lockCursor(tabID, resultID string) (*session, *cursor, error) {
	e.mu.Lock()
	s := e.tabs[tabID]
	e.mu.Unlock()
	if s == nil {
		return nil, nil, errors.New("no session for this tab")
	}
	if !s.busy.TryLock() {
		return nil, nil, errors.New("a query is running in this tab")
	}
	if s.cursor == nil || s.cursor.resultID != resultID {
		s.busy.Unlock()
		return nil, nil, errors.New("the result set is no longer open; run the query again")
	}
	return s, s.cursor, nil
}

// Rows streams every row of a result: the rows already fetched, then the
// rest of the open cursor when there is one (the cursor is consumed).
func (e *Executor) Rows(tabID, resultID string, header func([]Column) error, emit func([]any) error) error {
	e.mu.Lock()
	s := e.tabs[tabID]
	e.mu.Unlock()
	if s == nil {
		return errors.New("no session for this tab")
	}
	if !s.busy.TryLock() {
		return errors.New("a query is running in this tab")
	}
	defer s.busy.Unlock()
	c := s.results[resultID]
	if c == nil {
		return errors.New("result not found; run the query again")
	}
	if err := header(c.columns); err != nil {
		return err
	}
	for _, r := range c.rows {
		if err := emit(r); err != nil {
			return err
		}
	}
	if s.cursor == nil || s.cursor.resultID != resultID {
		return nil
	}
	defer s.closeCursor()
	cur := s.cursor
	for {
		row, err := scanRow(cur.rows, cur.ncols) // starts with the peeked row
		if err != nil {
			return err
		}
		if err := emit(row); err != nil {
			return err
		}
		if !cur.rows.Next() {
			return cur.rows.Err()
		}
	}
}

func (e *Executor) record(connID string, r Result, cancelled bool) {
	if e.hist == nil {
		return
	}
	status := "ok"
	switch {
	case cancelled:
		status = "cancelled"
	case r.Error != "":
		status = "error"
	}
	n := r.RowsAffected
	if r.IsQuery {
		n = int64(len(r.Rows))
	}
	e.hist.Record(history.Entry{
		ConnID:     connID,
		SQL:        r.Statement,
		StartedAt:  time.Now().UnixMilli() - r.DurationMs,
		DurationMs: r.DurationMs,
		Rows:       n,
		Status:     status,
		Error:      r.Error,
	})
}

func errText(ctx context.Context, err error) string {
	if ctx.Err() != nil {
		return "cancelled"
	}
	return err.Error()
}

func isBadConn(msg string) bool {
	return msg == driver.ErrBadConn.Error() || msg == sql.ErrConnDone.Error() || msg == "invalid connection"
}
