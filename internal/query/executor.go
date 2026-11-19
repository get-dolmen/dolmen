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

// TxIdleTimeout is how long a manual transaction may stay untouched before it
// is rolled back: an open transaction keeps locks and can block other sessions.
const TxIdleTimeout = 10 * time.Minute

// txReapInterval is how often open transactions are checked for inactivity.
const txReapInterval = 30 * time.Second

// TxExpired describes a manual transaction rolled back for inactivity.
type TxExpired struct {
	TabID      string `json:"tabId"`
	Statements int    `json:"statements"`
	StartedAt  int64  `json:"startedAt"` // unix ms
	TimeoutMs  int64  `json:"timeoutMs"`
}

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
	QueryContext(ctx context.Context, query string, arguments ...any) (*sql.Rows, error)
	ExecContext(ctx context.Context, query string, arguments ...any) (sql.Result, error)
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
	txLastUsed   time.Time
}

func (tabSession *session) txStatus() TxStatus {
	if tabSession.tx == nil {
		return TxStatus{}
	}
	return TxStatus{Open: true, Statements: tabSession.txStatements, StartedAt: tabSession.txSince.UnixMilli()}
}

// beginTx opens the manual transaction if needed. It is not bound to any
// run's context, so cancelling a statement does not end it by itself.
func (tabSession *session) beginTx() error {
	if tabSession.tx != nil {
		return nil
	}
	tx, err := tabSession.connection.BeginTx(context.Background(), nil)
	if err != nil {
		return err
	}
	tabSession.tx, tabSession.txStatements, tabSession.txSince = tx, 0, time.Now()
	tabSession.txLastUsed = tabSession.txSince
	return nil
}

func (tabSession *session) endTx(commit bool) error {
	if tabSession.tx == nil {
		return errors.New("no open transaction")
	}
	var err error
	if commit {
		err = tabSession.tx.Commit()
	} else {
		err = tabSession.tx.Rollback()
	}
	tabSession.tx, tabSession.txStatements = nil, 0
	tabSession.txSince, tabSession.txLastUsed = time.Time{}, time.Time{}
	return err
}

// expireIdleTx rolls back a transaction left untouched for longer than timeout.
// It returns what was rolled back when the transaction expired.
func (tabSession *session) expireIdleTx(timeout time.Duration) *TxExpired {
	if tabSession.tx == nil || timeout <= 0 || time.Since(tabSession.txLastUsed) < timeout {
		return nil
	}
	expired := &TxExpired{
		Statements: tabSession.txStatements,
		StartedAt:  tabSession.txSince.UnixMilli(),
		TimeoutMs:  timeout.Milliseconds(),
	}
	tabSession.closeCursor() // an open result set would block the rollback
	if err := tabSession.tx.Rollback(); err != nil {
		tabSession.reset() // the connection may be gone: start the next run clean
	} else {
		tabSession.tx, tabSession.txStatements = nil, 0
		tabSession.txSince, tabSession.txLastUsed = time.Time{}, time.Time{}
	}
	return expired
}

// reset discards the database session (and any transaction on it).
func (tabSession *session) reset() {
	tabSession.closeCursor()
	if tabSession.tx != nil {
		tabSession.tx.Rollback()
		tabSession.tx, tabSession.txStatements = nil, 0
		tabSession.txSince, tabSession.txLastUsed = time.Time{}, time.Time{}
	}
	if tabSession.connection != nil {
		tabSession.connection.Close()
		tabSession.connection = nil
	}
}

func (tabSession *session) closeCursor() {
	if tabSession.cursor != nil {
		tabSession.cursor.close()
		tabSession.cursor = nil
		tabSession.cancel.Store(nil)
	}
}

type Executor struct {
	connections  *conn.Manager
	historyStore *history.Store
	mu           sync.Mutex
	tabs         map[string]*session
	counter      atomic.Int64
	idleTimeout  time.Duration
	onTxExpired  func(TxExpired)
	stop         chan struct{}
	stopOnce     sync.Once
}

func NewExecutor(connections *conn.Manager, historyStore *history.Store) *Executor {
	executor := &Executor{
		connections:  connections,
		historyStore: historyStore,
		tabs:         map[string]*session{},
		idleTimeout:  TxIdleTimeout,
		stop:         make(chan struct{}),
	}
	go executor.reapTransactions()
	return executor
}

// Close stops the transaction reaper. Open transactions are rolled back by
// CloseAll / CloseTab.
func (e *Executor) Close() {
	e.stopOnce.Do(func() { close(e.stop) })
}

// SetTxExpiredHandler registers what to do when a transaction is rolled back
// for inactivity (the app emits it to the frontend).
func (e *Executor) SetTxExpiredHandler(handler func(TxExpired)) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.onTxExpired = handler
}

func (e *Executor) reapTransactions() {
	ticker := time.NewTicker(txReapInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			e.expireIdleTransactions()
		case <-e.stop:
			return
		}
	}
}

// expireIdleTransactions rolls back the transactions left untouched for longer
// than the executor's timeout.
func (e *Executor) expireIdleTransactions() {
	e.mu.Lock()
	candidates := make(map[string]*session, len(e.tabs))
	for tabID, tabSession := range e.tabs {
		candidates[tabID] = tabSession
	}
	e.mu.Unlock()

	for tabID, tabSession := range candidates {
		if !tabSession.busy.TryLock() {
			continue // a statement is running; the next tick will check again
		}
		expired := tabSession.expireIdleTx(e.idleTimeout)
		tabSession.busy.Unlock()
		if expired == nil {
			continue
		}
		expired.TabID = tabID
		e.mu.Lock()
		handler := e.onTxExpired
		live := e.tabs[tabID] == tabSession
		e.mu.Unlock()
		if live && handler != nil {
			handler(*expired)
		}
	}
}

func (e *Executor) newID() string { return "r" + strconv.FormatInt(e.counter.Add(1), 36) }

// sessionFor returns the tab's session, replacing it when the tab switched connection or database.
func (e *Executor) sessionFor(tabID, connID, database string) *session {
	e.mu.Lock()
	defer e.mu.Unlock()
	tabSession := e.tabs[tabID]
	if tabSession != nil && tabSession.connID == connID && tabSession.database == database {
		return tabSession
	}
	if tabSession != nil {
		go e.dropSession(tabSession)
	}
	tabSession = &session{connID: connID, database: database, results: map[string]*cached{}}
	e.tabs[tabID] = tabSession
	return tabSession
}

func (e *Executor) dropSession(tabSession *session) {
	if cancel := tabSession.cancel.Load(); cancel != nil {
		(*cancel)()
	}
	tabSession.busy.Lock()
	defer tabSession.busy.Unlock()
	tabSession.reset()
}

// CloseTab releases the tab's session.
func (e *Executor) CloseTab(tabID string) {
	e.mu.Lock()
	tabSession := e.tabs[tabID]
	delete(e.tabs, tabID)
	e.mu.Unlock()
	if tabSession != nil {
		e.dropSession(tabSession)
	}
}

// CloseConnection releases every session bound to a connection.
func (e *Executor) CloseConnection(connID string) {
	e.closeWhere(func(tabSession *session) bool { return tabSession.connID == connID })
}

// CloseDatabase releases the sessions bound to one database of a connection
// (not its main one), before that database is dropped.
func (e *Executor) CloseDatabase(connID, database string) {
	e.closeWhere(func(tabSession *session) bool { return tabSession.connID == connID && tabSession.database == database })
}

func (e *Executor) closeWhere(match func(*session) bool) {
	e.mu.Lock()
	var drop []*session
	for id, tabSession := range e.tabs {
		if match(tabSession) {
			drop = append(drop, tabSession)
			delete(e.tabs, id)
		}
	}
	e.mu.Unlock()
	for _, tabSession := range drop {
		e.dropSession(tabSession)
	}
}

// Cancel stops the running statement of a tab, if any.
func (e *Executor) Cancel(tabID string) {
	e.mu.Lock()
	tabSession := e.tabs[tabID]
	e.mu.Unlock()
	if tabSession == nil {
		return
	}
	if cancel := tabSession.cancel.Load(); cancel != nil {
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

	tabSession := e.sessionFor(request.TabID, request.ConnID, database)
	if !tabSession.busy.TryLock() {
		return nil, errors.New("a query is already running in this tab")
	}
	defer tabSession.busy.Unlock()
	tabSession.closeCursor()
	tabSession.results = map[string]*cached{}

	ctx, cancel := context.WithCancel(context.Background())
	tabSession.cancel.Store(&cancel)
	keepContext := false // true when the last result's cursor stays open
	defer func() {
		if !keepContext {
			tabSession.cancel.Store(nil)
			cancel()
		}
	}()

	if tabSession.connection == nil {
		connection, err := opened.DB.Conn(ctx)
		if err != nil {
			return nil, err
		}
		tabSession.connection = connection
	}

	manual := request.Manual && !opened.Config.ReadOnly
	if !manual && tabSession.tx != nil {
		return nil, errors.New("this tab has an open transaction: commit or roll back before switching to auto-commit")
	}

	var queryRunner querier = tabSession.connection
	var tx *sql.Tx // per-run read-only transaction (Oracle), not the manual one
	if stmt := opened.Driver.ReadOnlyTxStatement(); opened.Config.ReadOnly && stmt != "" {
		tx, err = tabSession.connection.BeginTx(ctx, nil)
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
				result = e.txControl(tabSession, control, statement.Text)
				result.DurationMs = time.Since(start).Milliseconds()
				result.End = end
				response.Results = append(response.Results, result)
				if result.Error != "" {
					break
				}
				continue
			}
			if err := tabSession.beginTx(); err != nil {
				response.Results = append(response.Results, Result{ID: e.newID(), Statement: statement.Text, RowsAffected: -1, Error: err.Error(), End: end})
				break
			}
			queryRunner = tabSession.tx
			tabSession.txStatements++
		}
		result, resultCursor = e.runOne(ctx, queryRunner, dialect, statement.Text, maxRows, last)
		if manual && tabSession.tx != nil {
			tabSession.txLastUsed = time.Now()
		}
		result.DurationMs = time.Since(start).Milliseconds()
		result.End = end
		response.Results = append(response.Results, result)
		e.record(request.ConnID, result, ctx.Err() != nil)
		if result.Error == "" && result.IsQuery {
			tabSession.results[result.ID] = &cached{columns: result.Columns, rows: result.Rows}
		}
		if resultCursor != nil {
			resultCursor.tx, resultCursor.cancel = tx, cancel
			tabSession.cursor = resultCursor
			keepContext = true
		}
		if result.Error != "" {
			break
		}
	}

	if ctx.Err() != nil {
		response.Cancelled = true
		response.Notice = "Query cancelled. The tab's database session was reset."
		if tabSession.tx != nil {
			response.Notice = "Query cancelled. The tab's database session was reset and its open transaction rolled back."
		}
		keepContext = false
		tabSession.reset() // the driver may have left the connection unusable
	} else if !keepContext && tx != nil {
		tx.Rollback()
	}
	if resultCount := len(response.Results); resultCount > 0 && response.Results[resultCount-1].Error != "" && isBadConn(response.Results[resultCount-1].Error) {
		tabSession.reset()
	}
	response.Tx = tabSession.txStatus()
	return response, nil
}

// txControl runs a COMMIT / ROLLBACK / BEGIN typed in manual mode.
func (e *Executor) txControl(tabSession *session, control, statement string) Result {
	result := Result{ID: e.newID(), Statement: statement, RowsAffected: -1, Rows: [][]any{}, Columns: []Column{}}
	switch control {
	case "begin":
		if tabSession.tx != nil {
			result.Message = "Already in a transaction (manual mode starts one automatically)."
			return result
		}
		if err := tabSession.beginTx(); err != nil {
			result.Error = err.Error()
			return result
		}
		result.Message = "Transaction started."
	case "commit", "rollback":
		if tabSession.tx == nil {
			result.Message = "No open transaction."
			return result
		}
		statementCount := tabSession.txStatements
		if err := tabSession.endTx(control == "commit"); err != nil {
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
	tabSession := e.tabs[tabID]
	e.mu.Unlock()
	if tabSession == nil {
		return TxStatus{}, errors.New("no open transaction")
	}
	if !tabSession.busy.TryLock() {
		return tabSession.txStatus(), errors.New("a query is running in this tab")
	}
	defer tabSession.busy.Unlock()
	tabSession.closeCursor() // an open result set would block the commit
	err := tabSession.endTx(commit)
	return tabSession.txStatus(), err
}

// TxStatusOf reports a tab's manual transaction.
func (e *Executor) TxStatusOf(tabID string) TxStatus {
	e.mu.Lock()
	tabSession := e.tabs[tabID]
	e.mu.Unlock()
	if tabSession == nil || !tabSession.busy.TryLock() {
		return TxStatus{}
	}
	defer tabSession.busy.Unlock()
	return tabSession.txStatus()
}

// Querier runs statements; *sql.Conn and *sql.Tx both satisfy it.
type Querier = querier

// WithSession runs operation on the tab's database session, so data tabs share the
// manual-transaction behaviour of SQL tabs:
//   - manual: operation runs inside the tab's open transaction (begun if needed);
//     writes are protected by a savepoint so a failed batch is undone alone;
//   - auto, write: operation runs in its own transaction, committed on success;
//   - auto, read: operation runs directly on the session.
//
// operation returns how many statements it executed (counted in the transaction).
func (e *Executor) WithSession(ctx context.Context, tabID, connID, database string, manual, write bool,
	operation func(ctx context.Context, open *conn.Open, runner Querier) (int, error)) (TxStatus, error) {
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
	tabSession := e.sessionFor(tabID, connID, database)
	if !tabSession.busy.TryLock() {
		return TxStatus{}, errors.New("this tab is busy")
	}
	defer tabSession.busy.Unlock()
	if !manual && tabSession.tx != nil {
		return tabSession.txStatus(), errors.New("this tab has an open transaction: commit or roll back before switching to auto-commit")
	}
	if tabSession.connection == nil {
		if tabSession.connection, err = opened.DB.Conn(ctx); err != nil {
			return TxStatus{}, err
		}
	}

	switch {
	case manual && write:
		if err := tabSession.beginTx(); err != nil {
			return TxStatus{}, err
		}
		if _, err := tabSession.tx.ExecContext(ctx, "SAVEPOINT dolmen_apply"); err != nil {
			return tabSession.txStatus(), err
		}
		statementCount, err := operation(ctx, opened, tabSession.tx)
		if err != nil {
			tabSession.tx.ExecContext(ctx, "ROLLBACK TO SAVEPOINT dolmen_apply")
			return tabSession.txStatus(), err
		}
		tabSession.txStatements += statementCount
		tabSession.txLastUsed = time.Now()
	case manual && tabSession.tx != nil:
		// Reads go through the open transaction so they see its changes.
		if _, err := operation(ctx, opened, tabSession.tx); err != nil {
			return tabSession.txStatus(), err
		}
		tabSession.txLastUsed = time.Now()
	case write:
		tx, err := tabSession.connection.BeginTx(ctx, nil)
		if err != nil {
			return TxStatus{}, err
		}
		defer tx.Rollback()
		if _, err := operation(ctx, opened, tx); err != nil {
			return TxStatus{}, err
		}
		if err := tx.Commit(); err != nil {
			return TxStatus{}, err
		}
	default:
		if _, err := operation(ctx, opened, tabSession.connection); err != nil {
			if isBadConn(err.Error()) {
				tabSession.reset()
			}
			return tabSession.txStatus(), err
		}
	}
	return tabSession.txStatus(), nil
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
	tabSession, openCursor, err := e.lockCursor(tabID, resultID)
	if err != nil {
		return nil, err
	}
	defer tabSession.busy.Unlock()
	if limit <= 0 {
		limit = DefaultMaxRows
	}
	// The pending row was already advanced to by the previous peek.
	first, err := ScanRow(openCursor.rows, openCursor.columnCount)
	if err != nil {
		tabSession.closeCursor()
		return &FetchResult{Rows: [][]any{}, Error: err.Error()}, nil
	}
	rest, more, err := fetch(openCursor.rows, openCursor.columnCount, limit-1)
	rows := append([][]any{first}, rest...)
	if cachedResult := tabSession.results[resultID]; cachedResult != nil {
		cachedResult.rows = append(cachedResult.rows, rows...)
	}
	result := &FetchResult{Rows: rows, HasMore: more}
	if err != nil {
		result.Error = err.Error()
	}
	if !more || err != nil {
		tabSession.closeCursor()
	}
	return result, nil
}

func (e *Executor) lockCursor(tabID, resultID string) (*session, *cursor, error) {
	e.mu.Lock()
	tabSession := e.tabs[tabID]
	e.mu.Unlock()
	if tabSession == nil {
		return nil, nil, errors.New("no session for this tab")
	}
	if !tabSession.busy.TryLock() {
		return nil, nil, errors.New("a query is running in this tab")
	}
	if tabSession.cursor == nil || tabSession.cursor.resultID != resultID {
		tabSession.busy.Unlock()
		return nil, nil, errors.New("the result set is no longer open; run the query again")
	}
	return tabSession, tabSession.cursor, nil
}

// Rows streams every row of a result: the rows already fetched, then the
// rest of the open cursor when there is one (the cursor is consumed).
func (e *Executor) Rows(tabID, resultID string, header func([]Column) error, emit func([]any) error) error {
	e.mu.Lock()
	tabSession := e.tabs[tabID]
	e.mu.Unlock()
	if tabSession == nil {
		return errors.New("no session for this tab")
	}
	if !tabSession.busy.TryLock() {
		return errors.New("a query is running in this tab")
	}
	defer tabSession.busy.Unlock()
	cachedResult := tabSession.results[resultID]
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
	if tabSession.cursor == nil || tabSession.cursor.resultID != resultID {
		return nil
	}
	defer tabSession.closeCursor()
	openCursor := tabSession.cursor
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

func isBadConn(message string) bool {
	return message == driver.ErrBadConn.Error() || message == sql.ErrConnDone.Error() || message == "invalid connection"
}
