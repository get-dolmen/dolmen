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
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// cursor is the open result set of the last statement of a run.
type cursor struct {
	resultID    string
	rows        *sql.Rows
	columnCount int
	tx          *sql.Tx
	cancel      context.CancelFunc
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
	connID     string
	database   string
	connection *sql.Conn
	busy       sync.Mutex // one run at a time per tab
	cancel     atomic.Pointer[context.CancelFunc]
	cursor     *cursor
	results    map[string]*cached
	// Manual-mode transaction, kept across runs.
	tx           *sql.Tx
	txStatements int
	txSince      time.Time
}

func (s *session) txStatus() TxStatus {
	if s.tx == nil {
		return TxStatus{}
	}
	return TxStatus{Open: true, Statements: s.txStatements, StartedAt: s.txSince.UnixMilli()}
}

// beginTx opens the manual transaction if needed. It is not bound to any
// run's context, so cancelling a statement does not end it by itself.
func (s *session) beginTx() error {
	if s.tx != nil {
		return nil
	}
	tx, err := s.connection.BeginTx(context.Background(), nil)
	if err != nil {
		return err
	}
	s.tx, s.txStatements, s.txSince = tx, 0, time.Now()
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
	if s.connection != nil {
		s.connection.Close()
		s.connection = nil
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
	connections  *conn.Manager
	historyStore *history.Store
	mu           sync.Mutex
	tabs         map[string]*session
	counter      atomic.Int64
}

func NewExecutor(connections *conn.Manager, historyStore *history.Store) *Executor {
	return &Executor{connections: connections, historyStore: historyStore, tabs: map[string]*session{}}
}

func (e *Executor) newID() string { return "r" + strconv.FormatInt(e.counter.Add(1), 36) }

// sessionFor returns the tab's session, replacing it when the tab switched connection or database.
func (e *Executor) sessionFor(tabID, connID, database string) *session {
	e.mu.Lock()
	defer e.mu.Unlock()
	s := e.tabs[tabID]
	if s != nil && s.connID == connID && s.database == database {
		return s
	}
	if s != nil {
		go e.dropSession(s)
	}
	s = &session{connID: connID, database: database, results: map[string]*cached{}}
	e.tabs[tabID] = s
	return s
}

func (e *Executor) dropSession(s *session) {
	if cancel := s.cancel.Load(); cancel != nil {
		(*cancel)()
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
func (e *Executor) CloseConnection(connID string) {
	e.closeWhere(func(s *session) bool { return s.connID == connID })
}

// CloseDatabase releases the sessions bound to one database of a connection
// (not its main one), before that database is dropped.
func (e *Executor) CloseDatabase(connID, database string) {
	e.closeWhere(func(s *session) bool { return s.connID == connID && s.database == database })
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
	if cancel := s.cancel.Load(); cancel != nil {
		(*cancel)()
	}
}

func (e *Executor) Execute(request ExecRequest) (*ExecResponse, error) {
	mainConnection, err := e.connections.Get(request.ConnID)
	if err != nil {
		return nil, err
	}
	database := request.Database
	if database == mainConnection.CurrentDB {
		database = "" // same session key as the main pool
	}
	opened, err := e.connections.GetDB(context.Background(), request.ConnID, database)
	if err != nil {
		return nil, err
	}
	dialect := sqlsplit.Dialect(opened.Config.Kind)

	statements := sqlsplit.Split(dialect, request.SQL)
	if request.Cursor >= 0 {
		statement, ok := sqlsplit.AtCursor(statements, sqlsplit.UTF16ToByteOffset(request.SQL, request.Cursor))
		statements = nil
		if ok {
			statements = []sqlsplit.Statement{statement}
		}
	}
	if len(statements) == 0 {
		return &ExecResponse{Results: []Result{}, Notice: "Nothing to run."}, nil
	}
	if opened.Config.ReadOnly {
		for _, statement := range statements {
			if err := sqlsplit.CheckReadOnly(dialect, statement.Text); err != nil {
				return &ExecResponse{Results: []Result{{ID: e.newID(), Statement: statement.Text, Error: err.Error(), End: sqlsplit.ByteToUTF16Offset(request.SQL, statement.End)}}}, nil
			}
		}
	}
	maxRows := request.MaxRows
	if maxRows <= 0 {
		maxRows = DefaultMaxRows
	}

	s := e.sessionFor(request.TabID, request.ConnID, database)
	if !s.busy.TryLock() {
		return nil, errors.New("a query is already running in this tab")
	}
	defer s.busy.Unlock()
	s.closeCursor()
	s.results = map[string]*cached{}

	ctx, cancel := context.WithCancel(context.Background())
	s.cancel.Store(&cancel)
	keepContext := false // true when the last result's cursor stays open
	defer func() {
		if !keepContext {
			s.cancel.Store(nil)
			cancel()
		}
	}()

	if s.connection == nil {
		connection, err := opened.DB.Conn(ctx)
		if err != nil {
			return nil, err
		}
		s.connection = connection
	}

	manual := request.Manual && !opened.Config.ReadOnly
	if !manual && s.tx != nil {
		return nil, errors.New("this tab has an open transaction: commit or roll back before switching to auto-commit")
	}

	var queryRunner querier = s.connection
	var tx *sql.Tx // per-run read-only transaction (Oracle), not the manual one
	if stmt := opened.Driver.ReadOnlyTxStatement(); opened.Config.ReadOnly && stmt != "" {
		tx, err = s.connection.BeginTx(ctx, nil)
		if err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, stmt); err != nil {
			tx.Rollback()
			return nil, err
		}
		queryRunner = tx
	}

	response := &ExecResponse{Results: make([]Result, 0, len(statements))}
	for index, statement := range statements {
		last := index == len(statements)-1
		end := sqlsplit.ByteToUTF16Offset(request.SQL, statement.End)
		start := time.Now()
		var result Result
		var resultCursor *cursor
		if manual {
			// COMMIT / ROLLBACK / BEGIN typed by the user act on the tab's transaction.
			if control := sqlsplit.TxControl(dialect, statement.Text); control != "" {
				result = e.txControl(s, control, statement.Text)
				result.DurationMs = time.Since(start).Milliseconds()
				result.End = end
				response.Results = append(response.Results, result)
				if result.Error != "" {
					break
				}
				continue
			}
			if err := s.beginTx(); err != nil {
				response.Results = append(response.Results, Result{ID: e.newID(), Statement: statement.Text, RowsAffected: -1, Error: err.Error(), End: end})
				break
			}
			queryRunner = s.tx
			s.txStatements++
		}
		result, resultCursor = e.runOne(ctx, queryRunner, dialect, statement.Text, maxRows, last)
		result.DurationMs = time.Since(start).Milliseconds()
		result.End = end
		response.Results = append(response.Results, result)
		e.record(request.ConnID, result, ctx.Err() != nil)
		if result.Error == "" && result.IsQuery {
			s.results[result.ID] = &cached{columns: result.Columns, rows: result.Rows}
		}
		if resultCursor != nil {
			resultCursor.tx, resultCursor.cancel = tx, cancel
			s.cursor = resultCursor
			keepContext = true
		}
		if result.Error != "" {
			break
		}
	}

	if ctx.Err() != nil {
		response.Cancelled = true
		response.Notice = "Query cancelled. The tab's database session was reset."
		if s.tx != nil {
			response.Notice = "Query cancelled. The tab's database session was reset and its open transaction rolled back."
		}
		keepContext = false
		s.reset() // the driver may have left the connection unusable
	} else if !keepContext && tx != nil {
		tx.Rollback()
	}
	if n := len(response.Results); n > 0 && response.Results[n-1].Error != "" && isBadConn(response.Results[n-1].Error) {
		s.reset()
	}
	response.Tx = s.txStatus()
	return response, nil
}

// txControl runs a COMMIT / ROLLBACK / BEGIN typed in manual mode.
func (e *Executor) txControl(s *session, control, statement string) Result {
	result := Result{ID: e.newID(), Statement: statement, RowsAffected: -1, Rows: [][]any{}, Columns: []Column{}}
	switch control {
	case "begin":
		if s.tx != nil {
			result.Message = "Already in a transaction (manual mode starts one automatically)."
			return result
		}
		if err := s.beginTx(); err != nil {
			result.Error = err.Error()
			return result
		}
		result.Message = "Transaction started."
	case "commit", "rollback":
		if s.tx == nil {
			result.Message = "No open transaction."
			return result
		}
		statementCount := s.txStatements
		if err := s.endTx(control == "commit"); err != nil {
			result.Error = err.Error()
			return result
		}
		verb := "Committed"
		if control == "rollback" {
			verb = "Rolled back"
		}
		result.Message = fmt.Sprintf("%s (%d statement%s).", verb, statementCount, plural(statementCount))
	}
	return result
}

func plural(count int) string {
	if count == 1 {
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
	fn func(ctx context.Context, open *conn.Open, runner Querier) (int, error)) (TxStatus, error) {
	mainConnection, err := e.connections.Get(connID)
	if err != nil {
		return TxStatus{}, err
	}
	if database == mainConnection.CurrentDB {
		database = ""
	}
	opened, err := e.connections.GetDB(ctx, connID, database)
	if err != nil {
		return TxStatus{}, err
	}
	manual = manual && !opened.Config.ReadOnly
	s := e.sessionFor(tabID, connID, database)
	if !s.busy.TryLock() {
		return TxStatus{}, errors.New("this tab is busy")
	}
	defer s.busy.Unlock()
	if !manual && s.tx != nil {
		return s.txStatus(), errors.New("this tab has an open transaction: commit or roll back before switching to auto-commit")
	}
	if s.connection == nil {
		if s.connection, err = opened.DB.Conn(ctx); err != nil {
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
		statementCount, err := fn(ctx, opened, s.tx)
		if err != nil {
			s.tx.ExecContext(ctx, "ROLLBACK TO SAVEPOINT dolmen_apply")
			return s.txStatus(), err
		}
		s.txStatements += statementCount
	case manual && s.tx != nil:
		// Reads go through the open transaction so they see its changes.
		if _, err := fn(ctx, opened, s.tx); err != nil {
			return s.txStatus(), err
		}
	case write:
		tx, err := s.connection.BeginTx(ctx, nil)
		if err != nil {
			return TxStatus{}, err
		}
		defer tx.Rollback()
		if _, err := fn(ctx, opened, tx); err != nil {
			return TxStatus{}, err
		}
		if err := tx.Commit(); err != nil {
			return TxStatus{}, err
		}
	default:
		if _, err := fn(ctx, opened, s.connection); err != nil {
			if isBadConn(err.Error()) {
				s.reset()
			}
			return s.txStatus(), err
		}
	}
	return s.txStatus(), nil
}

func (e *Executor) runOne(ctx context.Context, runner querier, dialect sqlsplit.Dialect, statement string, maxRows int, last bool) (Result, *cursor) {
	result := Result{ID: e.newID(), Statement: statement, RowsAffected: -1, Rows: [][]any{}, Columns: []Column{}}
	if !sqlsplit.ReturnsRows(dialect, statement) {
		execution, err := runner.ExecContext(ctx, statement)
		if err != nil {
			result.Error = errText(ctx, err)
			return result, nil
		}
		if affected, err := execution.RowsAffected(); err == nil {
			result.RowsAffected = affected
		}
		return result, nil
	}

	rows, err := runner.QueryContext(ctx, statement)
	if err != nil {
		result.Error = errText(ctx, err)
		return result, nil
	}
	result.IsQuery = true
	columnTypes, err := rows.ColumnTypes()
	if err != nil {
		rows.Close()
		result.Error = errText(ctx, err)
		return result, nil
	}
	for _, columnType := range columnTypes {
		result.Columns = append(result.Columns, Column{Name: columnType.Name(), Type: columnType.DatabaseTypeName()})
	}
	result.Rows, result.HasMore, err = fetch(rows, len(columnTypes), maxRows)
	if err != nil {
		rows.Close()
		result.Error = errText(ctx, err)
		return result, nil
	}
	if result.HasMore && last {
		result.CanFetchMore = true
		return result, &cursor{resultID: result.ID, rows: rows, columnCount: len(columnTypes)}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		result.Error = errText(ctx, err)
	}
	return result, nil
}

// fetch reads up to rowLimit rows; hasMore reports whether another row is pending.
func fetch(rows *sql.Rows, columnCount, rowLimit int) ([][]any, bool, error) {
	fetched := make([][]any, 0, min(rowLimit, 256))
	for len(fetched) < rowLimit {
		if !rows.Next() {
			return fetched, false, rows.Err()
		}
		row, err := ScanRow(rows, columnCount)
		if err != nil {
			return fetched, false, err
		}
		fetched = append(fetched, row)
	}
	// Peek: Next advances, so the peeked row is read first by the next fetch.
	if !rows.Next() {
		return fetched, false, rows.Err()
	}
	return fetched, true, nil
}

type FetchResult struct {
	Rows    [][]any `json:"rows"`
	HasMore bool    `json:"hasMore"`
	Error   string  `json:"error,omitempty"`
}

// FetchMore reads the next page of the tab's open cursor.
func (e *Executor) FetchMore(tabID, resultID string, limit int) (*FetchResult, error) {
	s, openCursor, err := e.lockCursor(tabID, resultID)
	if err != nil {
		return nil, err
	}
	defer s.busy.Unlock()
	if limit <= 0 {
		limit = DefaultMaxRows
	}
	// The pending row was already advanced to by the previous peek.
	first, err := ScanRow(openCursor.rows, openCursor.columnCount)
	if err != nil {
		s.closeCursor()
		return &FetchResult{Rows: [][]any{}, Error: err.Error()}, nil
	}
	rest, more, err := fetch(openCursor.rows, openCursor.columnCount, limit-1)
	rows := append([][]any{first}, rest...)
	if cachedResult := s.results[resultID]; cachedResult != nil {
		cachedResult.rows = append(cachedResult.rows, rows...)
	}
	result := &FetchResult{Rows: rows, HasMore: more}
	if err != nil {
		result.Error = err.Error()
	}
	if !more || err != nil {
		s.closeCursor()
	}
	return result, nil
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
	cachedResult := s.results[resultID]
	if cachedResult == nil {
		return errors.New("result not found; run the query again")
	}
	if err := header(cachedResult.columns); err != nil {
		return err
	}
	for _, row := range cachedResult.rows {
		if err := emit(row); err != nil {
			return err
		}
	}
	if s.cursor == nil || s.cursor.resultID != resultID {
		return nil
	}
	defer s.closeCursor()
	openCursor := s.cursor
	for {
		row, err := ScanRow(openCursor.rows, openCursor.columnCount) // starts with the peeked row
		if err != nil {
			return err
		}
		if err := emit(row); err != nil {
			return err
		}
		if !openCursor.rows.Next() {
			return openCursor.rows.Err()
		}
	}
}

func (e *Executor) record(connID string, result Result, cancelled bool) {
	if e.historyStore == nil {
		return
	}
	status := "ok"
	switch {
	case cancelled:
		status = "cancelled"
	case result.Error != "":
		status = "error"
	}
	rowCount := result.RowsAffected
	if result.IsQuery {
		rowCount = int64(len(result.Rows))
	}
	e.historyStore.Record(history.Entry{
		ConnID:     connID,
		SQL:        result.Statement,
		StartedAt:  time.Now().UnixMilli() - result.DurationMs,
		DurationMs: result.DurationMs,
		Rows:       rowCount,
		Status:     status,
		Error:      result.Error,
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
