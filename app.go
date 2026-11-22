package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"dolmen/internal/conn"
	"dolmen/internal/driver"
	"dolmen/internal/export"
	"dolmen/internal/folder"
	"dolmen/internal/gitsync"
	"dolmen/internal/history"
	"dolmen/internal/mcp"
	"dolmen/internal/query"
	"dolmen/internal/scratch"
	"dolmen/internal/tabledata"
)

const metaTimeout = 30 * time.Second

// App holds the services bound to the frontend. Every exported method is
// callable from Angular through the generated Wails bindings.
type App struct {
	app         *application.App
	store       *conn.Store
	connections *conn.Manager
	history     *history.Store
	executor    *query.Executor
	scratch     *scratch.Store
	folders     *folder.Store
	gitSync     *gitsync.Service
	mcp         *mcp.Service
	initErr     error

	// Set by InstallUpdate: whether an update was installed, and the argv
	// that starts the freshly installed build once this process exits.
	updateMu        sync.Mutex
	updateInstalled bool
	pendingRestart  []string
}

func NewApp() *App { return &App{} }

// ServiceStartup runs once the Wails application starts. A failed init is
// kept in initErr and reported by every call instead of aborting startup, so
// the window can still show the error.
func (a *App) ServiceStartup(context.Context, application.ServiceOptions) error {
	a.initErr = a.init()
	return nil
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
	a.connections = conn.NewManager()
	if a.history, err = history.Open(filepath.Join(dir, "dolmen.db")); err != nil {
		return fmt.Errorf("opening history: %w", err)
	}
	a.executor = query.NewExecutor(a.connections, a.history)
	a.executor.SetTxExpiredHandler(func(expired query.TxExpired) {
		a.app.Event.Emit("tx:expired", expired)
	})
	if a.scratch, err = scratch.NewStore(filepath.Join(dir, "scratch")); err != nil {
		return err
	}
	a.folders = folder.NewStore(dir)
	a.gitSync = gitsync.NewService(dir, a.store, a.folders, a.scratch)
	if a.mcp, err = mcp.NewService(dir, a.connections, a.store, a.history, version); err != nil {
		return fmt.Errorf("opening MCP settings: %w", err)
	}
	if a.mcp.Status().Enabled {
		_ = a.mcp.Start()
	}
	return nil
}

// ServiceShutdown releases connections and stores when the application quits.
func (a *App) ServiceShutdown() error {
	if a.mcp != nil {
		a.mcp.Stop()
	}
	if a.executor != nil {
		a.executor.Close()
	}
	if a.connections != nil {
		a.connections.CloseAll()
	}
	if a.history != nil {
		a.history.Close()
	}
	return nil
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
	HasPassword      bool `json:"hasPassword"`
	HasSSHPassword   bool `json:"hasSSHPassword"`
	HasSSHPassphrase bool `json:"hasSSHPassphrase"`
	Connected        bool `json:"connected"`
}

// view hides the stored secrets but remembers that they exist.
func view(config driver.Config, connected bool) ConnectionView {
	visible := ConnectionView{Config: config, HasPassword: config.Password != "", Connected: connected}
	visible.Password = ""
	if config.SSH != nil {
		ssh := *config.SSH
		visible.HasSSHPassword = ssh.Password != ""
		visible.HasSSHPassphrase = ssh.Passphrase != ""
		ssh.Password, ssh.Passphrase = "", ""
		visible.SSH = &ssh
	}
	return visible
}

func (a *App) ListConnections() ([]ConnectionView, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	configs, err := a.store.List()
	if err != nil {
		return nil, err
	}
	connectedIDs := map[string]bool{}
	for _, id := range a.connections.OpenIDs() {
		connectedIDs[id] = true
	}
	views := make([]ConnectionView, 0, len(configs))
	for _, config := range configs {
		views = append(views, view(config, connectedIDs[config.ID]))
	}
	return views, nil
}

// withStoredPassword keeps the saved password (and SSH secrets) when the form
// left them blank.
func (a *App) withStoredPassword(config driver.Config) driver.Config {
	if config.ID == "" {
		return config
	}
	stored, err := a.store.Get(config.ID)
	if err != nil {
		return config
	}
	if config.Password == "" {
		config.Password = stored.Password
	}
	if config.SSH != nil && stored.SSH != nil {
		ssh := *config.SSH
		if ssh.Password == "" {
			ssh.Password = stored.SSH.Password
		}
		if ssh.Passphrase == "" {
			ssh.Passphrase = stored.SSH.Passphrase
		}
		config.SSH = &ssh
	}
	return config
}

// SaveConnection creates or updates a connection. A blank password keeps the stored one.
func (a *App) SaveConnection(config driver.Config) (ConnectionView, error) {
	if err := a.ready(); err != nil {
		return ConnectionView{}, err
	}
	config = a.withStoredPassword(config)
	saved, err := a.store.Save(config)
	if err != nil {
		return ConnectionView{}, err
	}
	// Settings changed (e.g. read-only flag): reopen if it was connected.
	connected := false
	if _, err := a.connections.Get(saved.ID); err == nil {
		a.executor.CloseConnection(saved.ID)
		a.connections.Disconnect(saved.ID)
		ctx, cancel := metaCtx()
		defer cancel()
		_, err := a.connections.Connect(ctx, saved)
		connected = err == nil
	}
	return view(saved, connected), nil
}

func (a *App) DeleteConnection(id string) error {
	if err := a.ready(); err != nil {
		return err
	}
	a.Disconnect(id)
	return a.store.Delete(id)
}

// ---------- connection folders ----------

// ListFolders returns the explorer folders that group saved connections.
func (a *App) ListFolders() ([]folder.Folder, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.folders.List()
}

// SaveFolder creates or renames a folder. ParentID nests it inside another
// folder; folders can be nested to any depth.
func (a *App) SaveFolder(saved folder.Folder) (folder.Folder, error) {
	if err := a.ready(); err != nil {
		return folder.Folder{}, err
	}
	return a.folders.Save(saved)
}

// DeleteFolder removes a folder and moves its connections and sub-folders to
// the deleted folder's parent.
func (a *App) DeleteFolder(id string) error {
	if err := a.ready(); err != nil {
		return err
	}
	parent, err := a.folders.Delete(id)
	if err != nil {
		return err
	}
	configs, err := a.store.List()
	if err != nil {
		return err
	}
	for _, config := range configs {
		if config.FolderID == id {
			if err := a.store.SetFolder(config.ID, parent); err != nil {
				return err
			}
		}
	}
	return nil
}

// MoveConnectionToFolder files a connection under a folder ("" = root).
func (a *App) MoveConnectionToFolder(connID, folderID string) error {
	if err := a.ready(); err != nil {
		return err
	}
	if folderID != "" {
		allFolders, err := a.folders.List()
		if err != nil {
			return err
		}
		found := false
		for _, candidate := range allFolders {
			if candidate.ID == folderID {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("folder %s not found", folderID)
		}
	}
	return a.store.SetFolder(connID, folderID)
}

// ---------- MCP server ----------

// MCPStatus reports the local MCP server's settings and whether it is
// listening for clients.
func (a *App) MCPStatus() (mcp.Status, error) {
	if err := a.ready(); err != nil {
		return mcp.Status{}, err
	}
	return a.mcp.Status(), nil
}

// SaveMCPConfig stores the MCP settings and applies them immediately: the
// listener starts, stops or moves to another port as needed. Clients reach it
// on 127.0.0.1 only, with the access token.
func (a *App) SaveMCPConfig(config mcp.Config) (mcp.Status, error) {
	if err := a.ready(); err != nil {
		return mcp.Status{}, err
	}
	return a.mcp.Save(config)
}

// RegenerateMCPToken replaces the bearer token MCP clients must send.
func (a *App) RegenerateMCPToken() (mcp.Status, error) {
	if err := a.ready(); err != nil {
		return mcp.Status{}, err
	}
	return a.mcp.RegenerateToken()
}

// ---------- git sync ----------

// SyncStatus returns the git sync settings and the last sync result.
func (a *App) SyncStatus() (gitsync.Status, error) {
	if err := a.ready(); err != nil {
		return gitsync.Status{}, err
	}
	return a.gitSync.Status(), nil
}

// SaveSyncConfig stores the remote, branch and encryption choice. The master
// password itself is never saved.
func (a *App) SaveSyncConfig(config gitsync.Config) (gitsync.Config, error) {
	if err := a.ready(); err != nil {
		return gitsync.Config{}, err
	}
	return a.gitSync.SaveConfig(config)
}

// SyncNow merges the local connections, folders and scratch files with the
// git remote and writes the result back. password unlocks an encrypted
// bundle and must stay in the caller's memory.
func (a *App) SyncNow(password string) (gitsync.Result, error) {
	if err := a.ready(); err != nil {
		return gitsync.Result{}, err
	}
	return a.gitSync.Sync(password)
}

// TestConnection opens and pings a connection without keeping it, and
// returns the server version when it can be read.
func (a *App) TestConnection(config driver.Config) (string, error) {
	if err := a.ready(); err != nil {
		return "", err
	}
	config = a.withStoredPassword(config)
	ctx, cancel := metaCtx()
	defer cancel()
	opened, err := conn.Dial(ctx, config)
	if err != nil {
		return "", err
	}
	defer opened.Close()
	return serverVersion(ctx, opened), nil
}

func serverVersion(ctx context.Context, opened *conn.Open) string {
	statement := map[driver.Kind]string{
		driver.Postgres: "select version()",
		driver.MySQL:    "select concat('MySQL ', version())",
		driver.Oracle:   "select banner from v$version where rownum = 1",
		driver.SQLite:   "select 'SQLite ' || sqlite_version()",
	}[opened.Config.Kind]
	var banner string
	if err := opened.DB.QueryRowContext(ctx, statement).Scan(&banner); err != nil {
		return "Connected"
	}
	if index := strings.Index(banner, " on "); index > 0 && opened.Config.Kind == driver.Postgres {
		banner = banner[:index] // "PostgreSQL 16.2 on aarch64-..." → "PostgreSQL 16.2"
	}
	return banner
}

func (a *App) Connect(id string) error {
	if err := a.ready(); err != nil {
		return err
	}
	config, err := a.store.Get(id)
	if err != nil {
		return err
	}
	a.executor.CloseConnection(id)
	ctx, cancel := metaCtx()
	defer cancel()
	_, err = a.connections.Connect(ctx, config)
	return err
}

func (a *App) Disconnect(id string) {
	if a.ready() != nil {
		return
	}
	a.executor.CloseConnection(id)
	a.connections.Disconnect(id)
}

// PickSQLiteFile shows a native open dialog; "" when cancelled.
func (a *App) PickSQLiteFile() (string, error) {
	return a.app.Dialog.OpenFileWithOptions(&application.OpenFileDialogOptions{
		Title: "Choose a SQLite database",
		Filters: []application.FileFilter{
			{DisplayName: "SQLite databases", Pattern: "*.db;*.sqlite;*.sqlite3;*.db3"},
			{DisplayName: "All files", Pattern: "*"},
		},
	}).PromptForSingleSelection()
}

// PickSSHKey shows a native open dialog for an SSH private key; "" when cancelled.
// No extension filter: keys come as id_rsa, id_ed25519, *.pem, *.ppk and
// anything else. Hidden files are shown because keys usually live in ~/.ssh.
func (a *App) PickSSHKey() (string, error) {
	dialogOptions := &application.OpenFileDialogOptions{
		Title:           "Choose an SSH private key",
		ShowHiddenFiles: true,
	}
	if home, err := os.UserHomeDir(); err == nil {
		dir := filepath.Join(home, ".ssh")
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			dialogOptions.Directory = dir
		}
	}
	return a.app.Dialog.OpenFileWithOptions(dialogOptions).PromptForSingleSelection()
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
	return a.connections.GetDB(ctx, id, database)
}

type DatabaseList struct {
	// Supported is false for engines without a database level (MySQL, Oracle, SQLite).
	Supported bool     `json:"supported"`
	Databases []string `json:"databases"`
	Current   string   `json:"current"`
}

// ListDatabases lists the databases of a server (Postgres).
func (a *App) ListDatabases(connID string) (DatabaseList, error) {
	opened, err := a.open(connID, "")
	if err != nil {
		return DatabaseList{}, err
	}
	lister, ok := opened.Driver.(driver.DatabaseLister)
	if !ok {
		return DatabaseList{Databases: []string{}}, nil
	}
	ctx, cancel := metaCtx()
	defer cancel()
	databases, err := lister.ListDatabases(ctx, opened.DB)
	if err != nil {
		return DatabaseList{}, err
	}
	if databases == nil {
		databases = []string{}
	}
	return DatabaseList{Supported: true, Databases: databases, Current: opened.CurrentDB}, nil
}

func (a *App) ListSchemas(connID, database string) (SchemaList, error) {
	opened, err := a.open(connID, database)
	if err != nil {
		return SchemaList{}, err
	}
	ctx, cancel := metaCtx()
	defer cancel()
	schemas, err := opened.Driver.ListSchemas(ctx, opened.DB)
	if err != nil {
		return SchemaList{}, err
	}
	defaultSchema, _ := opened.Driver.DefaultSchema(ctx, opened.DB)
	if schemas == nil {
		schemas = []string{}
	}
	return SchemaList{Schemas: schemas, Default: defaultSchema}, nil
}

func (a *App) ListTables(connID, database, schema string) ([]driver.Table, error) {
	opened, err := a.open(connID, database)
	if err != nil {
		return nil, err
	}
	ctx, cancel := metaCtx()
	defer cancel()
	tables, err := opened.Driver.ListTables(ctx, opened.DB, schema)
	if tables == nil {
		tables = []driver.Table{}
	}
	return tables, err
}

// ListColumns returns the columns of one table, or of the whole schema when table is "".
func (a *App) ListColumns(connID, database, schema, table string) ([]driver.Column, error) {
	opened, err := a.open(connID, database)
	if err != nil {
		return nil, err
	}
	ctx, cancel := metaCtx()
	defer cancel()
	columns, err := opened.Driver.Columns(ctx, opened.DB, schema, table)
	if columns == nil {
		columns = []driver.Column{}
	}
	return columns, err
}

// ListForeignKeys returns the foreign keys declared in a schema: one row per
// column of each constraint.
func (a *App) ListForeignKeys(connID, database, schema string) ([]driver.ForeignKey, error) {
	opened, err := a.open(connID, database)
	if err != nil {
		return nil, err
	}
	lister, ok := opened.Driver.(driver.ForeignKeyLister)
	if !ok {
		return []driver.ForeignKey{}, nil
	}
	ctx, cancel := metaCtx()
	defer cancel()
	foreignKeys, err := lister.ListForeignKeys(ctx, opened.DB, schema)
	if foreignKeys == nil {
		foreignKeys = []driver.ForeignKey{}
	}
	return foreignKeys, err
}

func (a *App) TableDDL(connID, database, schema, table, objectType string) (string, error) {
	opened, err := a.open(connID, database)
	if err != nil {
		return "", err
	}
	ctx, cancel := metaCtx()
	defer cancel()
	return opened.Driver.TableDDL(ctx, opened.DB, schema, table, objectType)
}

// DropTable drops a table or a view from the connection's database.
func (a *App) DropTable(connID, database, schema, table, objectType string) error {
	if strings.TrimSpace(table) == "" {
		return errors.New("a table name is required")
	}
	opened, err := a.open(connID, database)
	if err != nil {
		return err
	}
	if opened.Config.ReadOnly {
		return errors.New("read-only connection: cannot drop objects")
	}
	kind := "TABLE"
	if objectType == "view" {
		kind = "VIEW"
	}
	target := opened.Driver.QuoteIdent(table)
	if schema != "" {
		target = opened.Driver.QuoteIdent(schema) + "." + target
	}
	ctx, cancel := metaCtx()
	defer cancel()
	_, err = opened.DB.ExecContext(ctx, "DROP "+kind+" "+target)
	return err
}

// CreateDatabase creates a database on the connection's server (engines
// with a database level, i.e. Postgres).
func (a *App) CreateDatabase(connID, name string) error {
	opened, err := a.serverPool(connID, name)
	if err != nil {
		return err
	}
	ctx, cancel := metaCtx()
	defer cancel()
	_, err = opened.DB.ExecContext(ctx, "CREATE DATABASE "+opened.Driver.QuoteIdent(name))
	return err
}

// DropDatabase drops another database of the connection's server. Dolmen's
// own sessions on it are closed first; the server refuses while any remain.
func (a *App) DropDatabase(connID, name string) error {
	opened, err := a.serverPool(connID, name)
	if err != nil {
		return err
	}
	if name == opened.CurrentDB {
		return fmt.Errorf("cannot drop %s: the connection itself uses it", name)
	}
	a.executor.CloseDatabase(connID, name)
	a.connections.CloseDB(connID, name)
	ctx, cancel := metaCtx()
	defer cancel()
	_, err = opened.DB.ExecContext(ctx, "DROP DATABASE "+opened.Driver.QuoteIdent(name))
	return err
}

// oraclePlainName matches names Oracle would fold to upper case if unquoted.
var oraclePlainName = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_$#]*$`)

// CreateSchema creates a schema. Each engine means something different by it:
// Postgres creates it in the given database, MySQL creates a database (its
// schemas), Oracle creates a schema-only user (18c+). SQLite schemas are
// attached files, so it is not supported there.
func (a *App) CreateSchema(connID, database, name string) error {
	if strings.TrimSpace(name) == "" {
		return errors.New("a schema name is required")
	}
	opened, err := a.open(connID, database)
	if err != nil {
		return err
	}
	if opened.Config.ReadOnly {
		return errors.New("read-only connection: cannot create schemas")
	}
	var statement string
	switch opened.Driver.Kind() {
	case driver.Postgres, driver.MySQL:
		statement = "CREATE SCHEMA " + opened.Driver.QuoteIdent(name)
	case driver.Oracle:
		// Quoting keeps the name exactly as given, so fold plain names the way
		// Oracle folds unquoted identifiers: "sales" becomes SALES.
		if oraclePlainName.MatchString(name) {
			name = strings.ToUpper(name)
		}
		statement = "CREATE USER " + opened.Driver.QuoteIdent(name) + " NO AUTHENTICATION"
	default:
		return fmt.Errorf("%s connections cannot create schemas", opened.Config.Kind)
	}
	ctx, cancel := metaCtx()
	defer cancel()
	_, err = opened.DB.ExecContext(ctx, statement)
	return err
}

// serverPool returns the main pool of a writable connection whose engine has
// a database level, for statements that act on whole databases.
func (a *App) serverPool(connID, name string) (*conn.Open, error) {
	if strings.TrimSpace(name) == "" {
		return nil, errors.New("a database name is required")
	}
	opened, err := a.open(connID, "")
	if err != nil {
		return nil, err
	}
	if opened.Config.ReadOnly {
		return nil, errors.New("read-only connection: cannot create or drop databases")
	}
	if _, ok := opened.Driver.(driver.DatabaseLister); !ok {
		return nil, fmt.Errorf("%s connections have no database level", opened.Config.Kind)
	}
	return opened, nil
}

// QuoteIdent quotes an identifier for the connection's dialect.
func (a *App) QuoteIdent(connID, name string) (string, error) {
	opened, err := a.open(connID, "")
	if err != nil {
		return "", err
	}
	return opened.Driver.QuoteIdent(name), nil
}

// ---------- execution ----------

func (a *App) Execute(request query.ExecRequest) (*query.ExecResponse, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.executor.Execute(request)
}

func (a *App) Cancel(tabID string) {
	if a.ready() == nil {
		a.executor.Cancel(tabID)
	}
}

func (a *App) FetchMore(tabID, resultID string, count int) (*query.FetchResult, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	return a.executor.FetchMore(tabID, resultID, count)
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
	exportFormat := export.Format(format)
	if exportFormat != export.CSV && exportFormat != export.JSON {
		return ExportResult{}, errors.New("unknown format")
	}
	path, err := a.app.Dialog.SaveFileWithOptions(&application.SaveFileDialogOptions{
		Title:    "Export results",
		Filename: "results-" + time.Now().Format("20060102-150405") + "." + format,
		Filters:  []application.FileFilter{{DisplayName: strings.ToUpper(format), Pattern: "*." + format}},
	}).PromptForSingleSelection()
	if err != nil || path == "" {
		return ExportResult{}, err
	}
	rows, err := export.ToFile(path, exportFormat, func(header func([]query.Column) error, row func([]any) error) error {
		return a.executor.Rows(tabID, resultID, header, row)
	})
	return ExportResult{Path: path, Rows: rows}, err
}

// ---------- table data (editable grid) ----------

// TableReadResult is a page of table data plus the tab's transaction state.
type TableReadResult struct {
	Page *tabledata.Page `json:"page"`
	Tx   query.TxStatus  `json:"tx"`
}

// ReadTable returns one page of a table for the data editor. It reads on the
// tab's own session, so a manual transaction sees its uncommitted changes.
func (a *App) ReadTable(tabID, connID, database string, manual bool, request tabledata.PageRequest) (TableReadResult, error) {
	if err := a.ready(); err != nil {
		return TableReadResult{}, err
	}
	ctx, cancel := metaCtx()
	defer cancel()
	var page *tabledata.Page
	transaction, err := a.executor.WithSession(ctx, tabID, connID, database, manual, false,
		func(ctx context.Context, opened *conn.Open, querier query.Querier) (int, error) {
			result, err := tabledata.Read(ctx, opened, querier, request)
			page = result
			return 0, err
		})
	return TableReadResult{Page: page, Tx: transaction}, err
}

// TableCountResult reports how many rows a table holds under a filter.
type TableCountResult struct {
	Count int64          `json:"count"`
	Tx    query.TxStatus `json:"tx"`
}

// CountTableRows counts the rows a table page shows, honouring the WHERE
// clause of the data editor and the tab's open transaction.
func (a *App) CountTableRows(tabID, connID, database string, manual bool, request tabledata.PageRequest) (TableCountResult, error) {
	if err := a.ready(); err != nil {
		return TableCountResult{}, err
	}
	ctx, cancel := metaCtx()
	defer cancel()
	var rowCount int64
	transaction, err := a.executor.WithSession(ctx, tabID, connID, database, manual, false,
		func(ctx context.Context, opened *conn.Open, querier query.Querier) (int, error) {
			total, err := tabledata.Count(ctx, opened, querier, request)
			rowCount = total
			return 0, err
		})
	return TableCountResult{Count: rowCount, Tx: transaction}, err
}

// TableApplyResult reports written rows plus the tab's transaction state.
type TableApplyResult struct {
	Result *tabledata.ApplyResult `json:"result"`
	Tx     query.TxStatus         `json:"tx"`
}

// ApplyTableChanges writes the grid's pending edits: committed at once in
// auto mode, or left in the tab's open transaction in manual mode.
func (a *App) ApplyTableChanges(tabID, connID, database string, manual bool, request tabledata.ApplyRequest) (TableApplyResult, error) {
	if err := a.ready(); err != nil {
		return TableApplyResult{}, err
	}
	ctx, cancel := metaCtx()
	defer cancel()
	var applied *tabledata.ApplyResult
	transaction, err := a.executor.WithSession(ctx, tabID, connID, database, manual, true,
		func(ctx context.Context, opened *conn.Open, querier query.Querier) (int, error) {
			result, err := tabledata.Apply(ctx, opened, querier, request)
			if err != nil {
				return 0, err
			}
			applied = result
			return result.Inserted + result.Updated + result.Deleted, nil
		})
	return TableApplyResult{Result: applied, Tx: transaction}, err
}

// ---------- transactions ----------

// Commit commits the tab's manual transaction.
func (a *App) Commit(tabID string) (query.TxStatus, error) {
	if err := a.ready(); err != nil {
		return query.TxStatus{}, err
	}
	return a.executor.EndTx(tabID, true)
}

// Rollback rolls back the tab's manual transaction.
func (a *App) Rollback(tabID string) (query.TxStatus, error) {
	if err := a.ready(); err != nil {
		return query.TxStatus{}, err
	}
	return a.executor.EndTx(tabID, false)
}

// TxStatus reports the tab's manual transaction.
func (a *App) TxStatus(tabID string) query.TxStatus {
	if a.ready() != nil {
		return query.TxStatus{}
	}
	return a.executor.TxStatusOf(tabID)
}

// ---------- history ----------

func (a *App) ListHistory(connID, search string, limit int) ([]history.Entry, error) {
	if err := a.ready(); err != nil {
		return nil, err
	}
	ctx, cancel := metaCtx()
	defer cancel()
	return a.history.List(ctx, connID, search, limit)
}

func (a *App) ClearHistory(connID string) error {
	if err := a.ready(); err != nil {
		return err
	}
	return a.history.Clear(connID)
}

// ---------- scratch tabs ----------

func (a *App) LoadWorkspace() (scratch.Workspace, error) {
	if err := a.ready(); err != nil {
		return scratch.Workspace{Tabs: []scratch.Tab{}}, err
	}
	return a.scratch.Load()
}

func (a *App) SaveWorkspaceLayout(workspace scratch.Workspace) error {
	if err := a.ready(); err != nil {
		return err
	}
	return a.scratch.SaveLayout(workspace)
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
	a.executor.CloseTab(id)
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

// SetScratchLock pins or unpins a scratch's connection and database link.
func (a *App) SetScratchLock(id string, locked bool) error {
	if err := a.ready(); err != nil {
		return err
	}
	return a.scratch.SetLock(id, locked)
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
	a.executor.CloseTab(id)
	return a.scratch.Delete(id)
}

// DuplicateScratch copies a scratch under a new name.
func (a *App) DuplicateScratch(id, newID, name string) (scratch.Tab, error) {
	if err := a.ready(); err != nil {
		return scratch.Tab{}, err
	}
	source, err := a.scratch.Get(id)
	if err != nil {
		return scratch.Tab{}, err
	}
	return a.scratch.Create(newID, name, source.ConnID, source.Database, source.Schema, source.Table, source.Content)
}

// ExportScratch saves a copy of a scratch to a .sql file chosen by the user.
// Returns the path, or "" when the dialog was cancelled.
func (a *App) ExportScratch(id string) (string, error) {
	if err := a.ready(); err != nil {
		return "", err
	}
	source, err := a.scratch.Get(id)
	if err != nil {
		return "", err
	}
	path, err := a.app.Dialog.SaveFileWithOptions(&application.SaveFileDialogOptions{
		Title:    "Save scratch as",
		Filename: source.Name,
		Filters:  []application.FileFilter{{DisplayName: "SQL files", Pattern: "*.sql"}},
	}).PromptForSingleSelection()
	if err != nil || path == "" {
		return "", err
	}
	return path, os.WriteFile(path, []byte(source.Content), 0o644)
}

// ImportScratch opens a .sql file from disk as a new scratch linked to the
// given connection. Returns an empty tab when the dialog was cancelled.
func (a *App) ImportScratch(newID, connID, database string) (scratch.Tab, error) {
	if err := a.ready(); err != nil {
		return scratch.Tab{}, err
	}
	path, err := a.app.Dialog.OpenFileWithOptions(&application.OpenFileDialogOptions{
		Title:   "Open a SQL file",
		Filters: []application.FileFilter{{DisplayName: "SQL files", Pattern: "*.sql;*.txt"}, {DisplayName: "All files", Pattern: "*"}},
	}).PromptForSingleSelection()
	if err != nil || path == "" {
		return scratch.Tab{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return scratch.Tab{}, err
	}
	if len(data) > 20<<20 {
		return scratch.Tab{}, errors.New("file is larger than 20 MB")
	}
	return a.scratch.Create(newID, filepath.Base(path), connID, database, "", "", string(data))
}

// ReleaseTabSession drops the tab's database session (e.g. when the tab
// switches connection) without deleting the tab.
func (a *App) ReleaseTabSession(id string) {
	if a.ready() == nil {
		a.executor.CloseTab(id)
	}
}
