package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"dolmen/internal/conn"
	"dolmen/internal/driver"
	"dolmen/internal/export"
	"dolmen/internal/history"
	"dolmen/internal/query"
	"dolmen/internal/scratch"
	"dolmen/internal/tabledata"
)

const metaTimeout = 30 * time.Second

// App holds the services bound to the frontend. Every exported method is
// callable from Angular through the generated wailsjs bindings.
type App struct {
	ctx     context.Context
	store   *conn.Store
	conns   *conn.Manager
	hist    *history.Store
	exec    *query.Executor
	scratch *scratch.Store
	initErr error
}

func NewApp() *App { return &App{} }

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.initErr = a.init()
}

func (a *App) init() error {
	base, err := os.UserConfigDir()
	if err != nil {
		return err
	}
	dir := filepath.Join(base, "dolmen")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	a.store = conn.NewStore(dir)
	a.conns = conn.NewManager()
	if a.hist, err = history.Open(filepath.Join(dir, "dolmen.db")); err != nil {
		return fmt.Errorf("opening history: %w", err)
	}
	a.exec = query.NewExecutor(a.conns, a.hist)
	if a.scratch, err = scratch.NewStore(filepath.Join(dir, "scratch")); err != nil {
		return err
	}
	return nil
}

func (a *App) shutdown(context.Context) {
	if a.conns != nil {
		a.conns.CloseAll()
	}
	if a.hist != nil {
		a.hist.Close()
	}
}

func (a *App) ready() error {
	if a.initErr != nil {
		return fmt.Errorf("dolmen failed to start: %w", a.initErr)
	}
	return nil
}

func metaCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), metaTimeout)
}

// ---------- connections ----------

// ConnectionView is a saved connection as the UI sees it: no password.
type ConnectionView struct {
	driver.Config
	HasPassword bool `json:"hasPassword"`
	Connected   bool `json:"connected"`
}

func (a *App) ListConnections() ([]ConnectionView, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	cfgs, err := a.store.List()
	if err != nil {
		return nil, err
	}
	open := map[string]bool{}
	for _, id := range a.conns.OpenIDs() {
		open[id] = true
	}
	out := make([]ConnectionView, 0, len(cfgs))
	for _, c := range cfgs {
		v := ConnectionView{Config: c, HasPassword: c.Password != "", Connected: open[c.ID]}
		v.Password = ""
		out = append(out, v)
	}
	return out, nil
}

// withStoredPassword keeps the saved password when the form left it blank.
func (a *App) withStoredPassword(cfg driver.Config) driver.Config {
	if cfg.Password == "" && cfg.ID != "" {
		if old, err := a.store.Get(cfg.ID); err == nil {
			cfg.Password = old.Password
		}
	}
	return cfg
}

// SaveConnection creates or updates a connection. A blank password keeps the stored one.
func (a *App) SaveConnection(cfg driver.Config) (ConnectionView, error) {
	if err := a.ready(); err != nil {
		return ConnectionView{}, err
	}
	cfg = a.withStoredPassword(cfg)
	saved, err := a.store.Save(cfg)
	if err != nil {
		return ConnectionView{}, err
	}
	// Settings changed (e.g. read-only flag): reopen if it was connected.
	connected := false
	if _, err := a.conns.Get(saved.ID); err == nil {
		a.exec.CloseConnection(saved.ID)
		a.conns.Disconnect(saved.ID)
		ctx, cancel := metaCtx()
		defer cancel()
		_, err := a.conns.Connect(ctx, saved)
		connected = err == nil
	}
	v := ConnectionView{Config: saved, HasPassword: saved.Password != "", Connected: connected}
	v.Password = ""
	return v, nil
}

func (a *App) DeleteConnection(id string) error {
	if err := a.ready(); err != nil {
		return err
	}
	a.Disconnect(id)
	return a.store.Delete(id)
}

// TestConnection opens and pings a connection without keeping it, and
// returns the server version when it can be read.
func (a *App) TestConnection(cfg driver.Config) (string, error) {
	if err := a.ready(); err != nil {
		return "", err
	}
	cfg = a.withStoredPassword(cfg)
	ctx, cancel := metaCtx()
	defer cancel()
	o, err := conn.Dial(ctx, cfg)
	if err != nil {
		return "", err
	}
	defer o.DB.Close()
	return serverVersion(ctx, o), nil
}

func serverVersion(ctx context.Context, o *conn.Open) string {
	q := map[driver.Kind]string{
		driver.Postgres: "select version()",
		driver.MySQL:    "select concat('MySQL ', version())",
		driver.Oracle:   "select banner from v$version where rownum = 1",
		driver.SQLite:   "select 'SQLite ' || sqlite_version()",
	}[o.Config.Kind]
	var v string
	if err := o.DB.QueryRowContext(ctx, q).Scan(&v); err != nil {
		return "Connected"
	}
	if i := strings.Index(v, " on "); i > 0 && o.Config.Kind == driver.Postgres {
		v = v[:i] // "PostgreSQL 16.2 on aarch64-..." → "PostgreSQL 16.2"
	}
	return v
}

func (a *App) Connect(id string) error {
	if err := a.ready(); err != nil {
		return err
	}
	cfg, err := a.store.Get(id)
	if err != nil {
		return err
	}
	a.exec.CloseConnection(id)
	ctx, cancel := metaCtx()
	defer cancel()
	_, err = a.conns.Connect(ctx, cfg)
	return err
}

func (a *App) Disconnect(id string) {
	if a.ready() != nil {
		return
	}
	a.exec.CloseConnection(id)
	a.conns.Disconnect(id)
}

// PickSQLiteFile shows a native open dialog; "" when cancelled.
func (a *App) PickSQLiteFile() (string, error) {
	return runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Choose a SQLite database",
		Filters: []runtime.FileFilter{
			{DisplayName: "SQLite databases", Pattern: "*.db;*.sqlite;*.sqlite3;*.db3"},
			{DisplayName: "All files", Pattern: "*"},
		},
	})
}

// ---------- schema ----------

type SchemaList struct {
	Schemas []string `json:"schemas"`
	Default string   `json:"default"`
}

// open returns the pool for a connection's database ("" = its own).
func (a *App) open(id, database string) (*conn.Open, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	ctx, cancel := metaCtx()
	defer cancel()
	return a.conns.GetDB(ctx, id, database)
}

type DatabaseList struct {
	// Supported is false for engines without a database level (MySQL, Oracle, SQLite).
	Supported bool     `json:"supported"`
	Databases []string `json:"databases"`
	Current   string   `json:"current"`
}

// ListDatabases lists the databases of a server (Postgres).
func (a *App) ListDatabases(connID string) (DatabaseList, error) {
	o, err := a.open(connID, "")
	if err != nil {
		return DatabaseList{}, err
	}
	l, ok := o.Driver.(driver.DatabaseLister)
	if !ok {
		return DatabaseList{Databases: []string{}}, nil
	}
	ctx, cancel := metaCtx()
	defer cancel()
	dbs, err := l.ListDatabases(ctx, o.DB)
	if err != nil {
		return DatabaseList{}, err
	}
	if dbs == nil {
		dbs = []string{}
	}
	return DatabaseList{Supported: true, Databases: dbs, Current: o.CurrentDB}, nil
}

func (a *App) ListSchemas(connID, database string) (SchemaList, error) {
	o, err := a.open(connID, database)
	if err != nil {
		return SchemaList{}, err
	}
	ctx, cancel := metaCtx()
	defer cancel()
	schemas, err := o.Driver.ListSchemas(ctx, o.DB)
	if err != nil {
		return SchemaList{}, err
	}
	def, _ := o.Driver.DefaultSchema(ctx, o.DB)
	if schemas == nil {
		schemas = []string{}
	}
	return SchemaList{Schemas: schemas, Default: def}, nil
}

func (a *App) ListTables(connID, database, schema string) ([]driver.Table, error) {
	o, err := a.open(connID, database)
	if err != nil {
		return nil, err
	}
	ctx, cancel := metaCtx()
	defer cancel()
	t, err := o.Driver.ListTables(ctx, o.DB, schema)
	if t == nil {
		t = []driver.Table{}
	}
	return t, err
}

// ListColumns returns the columns of one table, or of the whole schema when table is "".
func (a *App) ListColumns(connID, database, schema, table string) ([]driver.Column, error) {
	o, err := a.open(connID, database)
	if err != nil {
		return nil, err
	}
	ctx, cancel := metaCtx()
	defer cancel()
	c, err := o.Driver.Columns(ctx, o.DB, schema, table)
	if c == nil {
		c = []driver.Column{}
	}
	return c, err
}

func (a *App) TableDDL(connID, database, schema, table, typ string) (string, error) {
	o, err := a.open(connID, database)
	if err != nil {
		return "", err
	}
	ctx, cancel := metaCtx()
	defer cancel()
	return o.Driver.TableDDL(ctx, o.DB, schema, table, typ)
}

// QuoteIdent quotes an identifier for the connection's dialect.
func (a *App) QuoteIdent(connID, name string) (string, error) {
	o, err := a.open(connID, "")
	if err != nil {
		return "", err
	}
	return o.Driver.QuoteIdent(name), nil
}

// ---------- execution ----------

func (a *App) Execute(req query.ExecRequest) (*query.ExecResponse, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.exec.Execute(req)
}

func (a *App) Cancel(tabID string) {
	if a.ready() == nil {
		a.exec.Cancel(tabID)
	}
}

func (a *App) FetchMore(tabID, resultID string, n int) (*query.FetchResult, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.exec.FetchMore(tabID, resultID, n)
}

type ExportResult struct {
	Path string `json:"path"` // "" when the dialog was cancelled
	Rows int64  `json:"rows"`
}

// ExportResult asks for a destination and writes every row of a result,
// including rows not yet fetched into the grid.
func (a *App) ExportResult(tabID, resultID, format string) (ExportResult, error) {
	if err := a.ready(); err != nil {
		return ExportResult{}, err
	}
	f := export.Format(format)
	if f != export.CSV && f != export.JSON {
		return ExportResult{}, errors.New("unknown format")
	}
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Export results",
		DefaultFilename: "results-" + time.Now().Format("20060102-150405") + "." + format,
		Filters:         []runtime.FileFilter{{DisplayName: strings.ToUpper(format), Pattern: "*." + format}},
	})
	if err != nil || path == "" {
		return ExportResult{}, err
	}
	n, err := export.ToFile(path, f, func(header func([]query.Column) error, row func([]any) error) error {
		return a.exec.Rows(tabID, resultID, header, row)
	})
	return ExportResult{Path: path, Rows: n}, err
}

// ---------- table data (editable grid) ----------

// TableReadResult is a page of table data plus the tab's transaction state.
type TableReadResult struct {
	Page *tabledata.Page `json:"page"`
	Tx   query.TxStatus  `json:"tx"`
}

// ReadTable returns one page of a table for the data editor. It reads on the
// tab's own session, so a manual transaction sees its uncommitted changes.
func (a *App) ReadTable(tabID, connID, database string, manual bool, req tabledata.PageRequest) (TableReadResult, error) {
	if err := a.ready(); err != nil {
		return TableReadResult{}, err
	}
	ctx, cancel := metaCtx()
	defer cancel()
	var page *tabledata.Page
	tx, err := a.exec.WithSession(ctx, tabID, connID, database, manual, false,
		func(ctx context.Context, o *conn.Open, q query.Querier) (int, error) {
			p, err := tabledata.Read(ctx, o, q, req)
			page = p
			return 0, err
		})
	return TableReadResult{Page: page, Tx: tx}, err
}

// TableApplyResult reports written rows plus the tab's transaction state.
type TableApplyResult struct {
	Result *tabledata.ApplyResult `json:"result"`
	Tx     query.TxStatus         `json:"tx"`
}

// ApplyTableChanges writes the grid's pending edits: committed at once in
// auto mode, or left in the tab's open transaction in manual mode.
func (a *App) ApplyTableChanges(tabID, connID, database string, manual bool, req tabledata.ApplyRequest) (TableApplyResult, error) {
	if err := a.ready(); err != nil {
		return TableApplyResult{}, err
	}
	ctx, cancel := metaCtx()
	defer cancel()
	var res *tabledata.ApplyResult
	tx, err := a.exec.WithSession(ctx, tabID, connID, database, manual, true,
		func(ctx context.Context, o *conn.Open, q query.Querier) (int, error) {
			r, err := tabledata.Apply(ctx, o, q, req)
			if err != nil {
				return 0, err
			}
			res = r
			return r.Inserted + r.Updated + r.Deleted, nil
		})
	return TableApplyResult{Result: res, Tx: tx}, err
}

// ---------- transactions ----------

// Commit commits the tab's manual transaction.
func (a *App) Commit(tabID string) (query.TxStatus, error) {
	if err := a.ready(); err != nil {
		return query.TxStatus{}, err
	}
	return a.exec.EndTx(tabID, true)
}

// Rollback rolls back the tab's manual transaction.
func (a *App) Rollback(tabID string) (query.TxStatus, error) {
	if err := a.ready(); err != nil {
		return query.TxStatus{}, err
	}
	return a.exec.EndTx(tabID, false)
}

// TxStatus reports the tab's manual transaction.
func (a *App) TxStatus(tabID string) query.TxStatus {
	if a.ready() != nil {
		return query.TxStatus{}
	}
	return a.exec.TxStatusOf(tabID)
}

// ---------- history ----------

func (a *App) ListHistory(connID, search string, limit int) ([]history.Entry, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	ctx, cancel := metaCtx()
	defer cancel()
	return a.hist.List(ctx, connID, search, limit)
}

func (a *App) ClearHistory(connID string) error {
	if err := a.ready(); err != nil {
		return err
	}
	return a.hist.Clear(connID)
}

// ---------- scratch tabs ----------

func (a *App) LoadWorkspace() (scratch.Workspace, error) {
	if err := a.ready(); err != nil {
		return scratch.Workspace{Tabs: []scratch.Tab{}}, err
	}
	return a.scratch.Load()
}

func (a *App) SaveWorkspaceLayout(ws scratch.Workspace) error {
	if err := a.ready(); err != nil {
		return err
	}
	return a.scratch.SaveLayout(ws)
}

func (a *App) SaveTabContent(id, content string) error {
	if err := a.ready(); err != nil {
		return err
	}
	return a.scratch.SaveContent(id, content)
}

// CloseTab releases a tab's database session. The scratch file is kept,
// unless it is still empty (an untouched "New tab").
func (a *App) CloseTab(id string) error {
	if err := a.ready(); err != nil {
		return err
	}
	a.exec.CloseTab(id)
	if a.scratch.IsBlank(id) {
		return a.scratch.Delete(id)
	}
	return nil
}

// ---------- scratch files ----------

// ListScratches returns every scratch file, most recently edited first.
func (a *App) ListScratches() ([]scratch.Info, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.scratch.List(), nil
}

// OpenScratch returns a scratch with its content, ready to open in a tab.
func (a *App) OpenScratch(id string) (scratch.Tab, error) {
	if err := a.ready(); err != nil {
		return scratch.Tab{}, err
	}
	return a.scratch.Get(id)
}

// CreateScratch creates a scratch filed under a connection, database and
// optionally a table (schema + table).
func (a *App) CreateScratch(id, name, connID, database, schema, table, content string) (scratch.Tab, error) {
	if err := a.ready(); err != nil {
		return scratch.Tab{}, err
	}
	return a.scratch.Create(id, name, connID, database, schema, table, content)
}

// LinkScratch moves a scratch to another folder: connection, database and
// optionally a table.
func (a *App) LinkScratch(id, connID, database, schema, table string) error {
	if err := a.ready(); err != nil {
		return err
	}
	return a.scratch.Link(id, connID, database, schema, table)
}

// RenameScratch renames a scratch; ".sql" is added when the name has no extension.
func (a *App) RenameScratch(id, name string) (string, error) {
	if err := a.ready(); err != nil {
		return "", err
	}
	return a.scratch.Rename(id, name)
}

// DeleteScratch deletes a scratch file (and releases its tab's session).
func (a *App) DeleteScratch(id string) error {
	if err := a.ready(); err != nil {
		return err
	}
	a.exec.CloseTab(id)
	return a.scratch.Delete(id)
}

// DuplicateScratch copies a scratch under a new name.
func (a *App) DuplicateScratch(id, newID, name string) (scratch.Tab, error) {
	if err := a.ready(); err != nil {
		return scratch.Tab{}, err
	}
	src, err := a.scratch.Get(id)
	if err != nil {
		return scratch.Tab{}, err
	}
	return a.scratch.Create(newID, name, src.ConnID, src.Database, src.Schema, src.Table, src.Content)
}

// ExportScratch saves a copy of a scratch to a .sql file chosen by the user.
// Returns the path, or "" when the dialog was cancelled.
func (a *App) ExportScratch(id string) (string, error) {
	if err := a.ready(); err != nil {
		return "", err
	}
	src, err := a.scratch.Get(id)
	if err != nil {
		return "", err
	}
	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "Save scratch as",
		DefaultFilename: src.Name,
		Filters:         []runtime.FileFilter{{DisplayName: "SQL files", Pattern: "*.sql"}},
	})
	if err != nil || path == "" {
		return "", err
	}
	return path, os.WriteFile(path, []byte(src.Content), 0o644)
}

// ImportScratch opens a .sql file from disk as a new scratch linked to the
// given connection. Returns an empty tab when the dialog was cancelled.
func (a *App) ImportScratch(newID, connID, database string) (scratch.Tab, error) {
	if err := a.ready(); err != nil {
		return scratch.Tab{}, err
	}
	path, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:   "Open a SQL file",
		Filters: []runtime.FileFilter{{DisplayName: "SQL files", Pattern: "*.sql;*.txt"}, {DisplayName: "All files", Pattern: "*"}},
	})
	if err != nil || path == "" {
		return scratch.Tab{}, err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return scratch.Tab{}, err
	}
	if len(b) > 20<<20 {
		return scratch.Tab{}, errors.New("file is larger than 20 MB")
	}
	return a.scratch.Create(newID, filepath.Base(path), connID, database, "", "", string(b))
}

// ReleaseTabSession drops the tab's database session (e.g. when the tab
// switches connection) without deleting the tab.
func (a *App) ReleaseTabSession(id string) {
	if a.ready() == nil {
		a.exec.CloseTab(id)
	}
}
