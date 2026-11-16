package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"dolmen/internal/conn"
	"dolmen/internal/driver"
	"dolmen/internal/history"
)

// Tools implements the MCP tools. It reads the current policy on every call,
// so changing permissions in the settings dialog applies immediately.
type Tools struct {
	conns  *conn.Manager
	saved  *conn.Store
	hist   *history.Store
	policy func() Config
}

func NewTools(conns *conn.Manager, saved *conn.Store, hist *history.Store, policy func() Config) *Tools {
	return &Tools{conns: conns, saved: saved, hist: hist, policy: policy}
}

// Tool is one entry of the MCP tools/list result.
type Tool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

// ListTools describes the tools available under the current permissions.
func (t *Tools) ListTools() []Tool {
	cfg := t.config()
	if !cfg.AllowsRead() {
		return []Tool{}
	}
	tools := []Tool{
		{
			Name:        "list_connections",
			Description: "List the saved connections in Dolmen. Use the name or id as the `connection` argument of the other tools.",
			InputSchema: object(nil),
		},
		{
			Name:        "list_databases",
			Description: "List the databases a saved connection can open, filtered by the MCP permissions.",
			InputSchema: object(map[string]any{
				"connection": text("Saved connection name or id."),
			}, "connection"),
		},
		{
			Name:        "list_schemas",
			Description: "List the schemas of a database, filtered by the MCP permissions.",
			InputSchema: object(map[string]any{
				"connection": text("Saved connection name or id."),
				"database":   text("Database to open; empty uses the connection's own database."),
			}, "connection"),
		},
		{
			Name:        "list_tables",
			Description: "List the tables and views of a schema.",
			InputSchema: object(map[string]any{
				"connection": text("Saved connection name or id."),
				"database":   text("Database to open; empty uses the connection's own database."),
				"schema":     text("Schema to inspect; empty uses the connection's default schema."),
			}, "connection"),
		},
		{
			Name:        "describe_table",
			Description: "List the columns of a table or view: name, type, nullability and primary-key flag.",
			InputSchema: object(map[string]any{
				"connection": text("Saved connection name or id."),
				"database":   text("Database to open; empty uses the connection's own database."),
				"schema":     text("Schema holding the table; empty uses the connection's default schema."),
				"table":      text("Table or view name."),
			}, "connection", "table"),
		},
		{
			Name:        "get_table_ddl",
			Description: "Return the CREATE statement of a table or view.",
			InputSchema: object(map[string]any{
				"connection": text("Saved connection name or id."),
				"database":   text("Database to open; empty uses the connection's own database."),
				"schema":     text("Schema holding the object; empty uses the connection's default schema."),
				"table":      text("Table or view name."),
				"type":       map[string]any{"type": "string", "enum": []string{"table", "view"}, "description": "Object kind; defaults to table."},
			}, "connection", "table"),
		},
	}
	tools = append(tools, Tool{
		Name:        "read_query",
		Description: "Run read-only SQL (SELECT, WITH, SHOW, EXPLAIN, …) and return the rows. Use write_query for changes.",
		InputSchema: object(map[string]any{
			"connection": text("Saved connection name or id."),
			"database":   text("Database to open; empty uses the connection's own database."),
			"sql":        text("One or more read-only statements."),
			"maxRows":    number("Maximum rows per statement (default 100, at most 1000).", 1, maxQueryRows),
		}, "connection", "sql"),
	})
	if cfg.AllowsWrite() {
		tools = append(tools, Tool{
			Name:        "write_query",
			Description: "Run SQL that changes data or schema. All statements run in one transaction unless the engine commits DDL implicitly.",
			InputSchema: object(map[string]any{
				"connection": text("Saved connection name or id."),
				"database":   text("Database to open; empty uses the connection's own database."),
				"sql":        text("One or more statements to run."),
			}, "connection", "sql"),
		})
	}
	return tools
}

// Call runs one tool. Errors are reported to the client as tool errors, not
// as JSON-RPC protocol errors.
func (t *Tools) Call(ctx context.Context, name string, raw json.RawMessage) (any, error) {
	cfg := t.config()
	if !cfg.Enabled {
		return nil, errors.New("the MCP server is disabled")
	}
	switch name {
	case "list_connections":
		if err := requireRead(cfg); err != nil {
			return nil, err
		}
		return t.listConnections()
	case "list_databases":
		if err := requireRead(cfg); err != nil {
			return nil, err
		}
		var args targetArgs
		if err := decodeArgs(raw, &args); err != nil {
			return nil, err
		}
		return t.listDatabases(ctx, cfg, args)
	case "list_schemas":
		if err := requireRead(cfg); err != nil {
			return nil, err
		}
		var args targetArgs
		if err := decodeArgs(raw, &args); err != nil {
			return nil, err
		}
		return t.listSchemas(ctx, cfg, args)
	case "list_tables":
		if err := requireRead(cfg); err != nil {
			return nil, err
		}
		var args schemaArgs
		if err := decodeArgs(raw, &args); err != nil {
			return nil, err
		}
		return t.listTables(ctx, cfg, args)
	case "describe_table":
		if err := requireRead(cfg); err != nil {
			return nil, err
		}
		var args tableArgs
		if err := decodeArgs(raw, &args); err != nil {
			return nil, err
		}
		return t.describeTable(ctx, cfg, args)
	case "get_table_ddl":
		if err := requireRead(cfg); err != nil {
			return nil, err
		}
		var args ddlArgs
		if err := decodeArgs(raw, &args); err != nil {
			return nil, err
		}
		return t.tableDDL(ctx, cfg, args)
	case "read_query":
		if err := requireRead(cfg); err != nil {
			return nil, err
		}
		var args queryArgs
		if err := decodeArgs(raw, &args); err != nil {
			return nil, err
		}
		return t.readQuery(ctx, cfg, args)
	case "write_query":
		if err := requireWrite(cfg); err != nil {
			return nil, err
		}
		var args queryArgs
		if err := decodeArgs(raw, &args); err != nil {
			return nil, err
		}
		return t.writeQuery(ctx, cfg, args)
	}
	return nil, fmt.Errorf("unknown tool %q", name)
}

func (t *Tools) config() Config {
	if t.policy == nil {
		return DefaultConfig()
	}
	return t.policy()
}

func requireRead(cfg Config) error {
	if !cfg.AllowsRead() {
		return errors.New("reading is disabled in Dolmen's MCP settings")
	}
	return nil
}

func requireWrite(cfg Config) error {
	if !cfg.AllowsWrite() {
		return errors.New("writing is disabled in Dolmen's MCP settings")
	}
	return nil
}

type targetArgs struct {
	Connection string `json:"connection"`
	Database   string `json:"database"`
}

type schemaArgs struct {
	targetArgs
	Schema string `json:"schema"`
}

type tableArgs struct {
	schemaArgs
	Table string `json:"table"`
}

type ddlArgs struct {
	tableArgs
	Type string `json:"type"`
}

// target is a saved connection open on one database.
type target struct {
	cfg      driver.Config
	open     *conn.Open
	database string
}

func (t *Tools) target(ctx context.Context, ref, database string) (*target, error) {
	cfg, err := t.savedConnection(ref)
	if err != nil {
		return nil, err
	}
	policy := t.config()
	database = strings.TrimSpace(database)
	if database == "" {
		database = cfg.Database
	}
	if !policy.AllowsDatabase(cfg.Kind, database) {
		return nil, fmt.Errorf("database %q is not allowed by the MCP permissions", database)
	}
	o, err := t.conns.Get(cfg.ID)
	if err != nil {
		// Saved connections are opened on demand, so clients do not need the
		// user to connect first.
		o, err = t.conns.Connect(ctx, cfg)
		if err != nil {
			return nil, fmt.Errorf("connecting to %s: %w", cfg.Name, err)
		}
	}
	if database != "" && database != o.CurrentDB {
		o, err = t.conns.GetDB(ctx, cfg.ID, database)
		if err != nil {
			return nil, err
		}
	}
	actual := databaseName(cfg, o)
	if !policy.AllowsDatabase(cfg.Kind, actual) {
		return nil, fmt.Errorf("database %q is not allowed by the MCP permissions", actual)
	}
	return &target{cfg: cfg, open: o, database: actual}, nil
}

// savedConnection resolves a connection by id or by unique name.
func (t *Tools) savedConnection(ref string) (driver.Config, error) {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return driver.Config{}, errors.New("a connection name or id is required")
	}
	cfgs, err := t.saved.List()
	if err != nil {
		return driver.Config{}, err
	}
	for _, c := range cfgs {
		if c.ID == ref {
			return c, nil
		}
	}
	var found *driver.Config
	for i := range cfgs {
		if strings.EqualFold(cfgs[i].Name, ref) {
			if found != nil {
				return driver.Config{}, fmt.Errorf("connection name %q is ambiguous; use its id", ref)
			}
			found = &cfgs[i]
		}
	}
	if found == nil {
		return driver.Config{}, fmt.Errorf("connection %q not found", ref)
	}
	return *found, nil
}

// databaseName is the database a pool is bound to, or the SQLite file's name.
func databaseName(cfg driver.Config, o *conn.Open) string {
	if o.CurrentDB != "" {
		return o.CurrentDB
	}
	if cfg.Database != "" {
		return cfg.Database
	}
	if cfg.Kind == driver.SQLite {
		return filepath.Base(cfg.FilePath)
	}
	return ""
}

type connectionInfo struct {
	ID        string      `json:"id"`
	Name      string      `json:"name"`
	Kind      driver.Kind `json:"kind"`
	Database  string      `json:"database,omitempty"`
	ReadOnly  bool        `json:"readOnly"`
	Connected bool        `json:"connected"`
}

func (t *Tools) listConnections() ([]connectionInfo, error) {
	cfgs, err := t.saved.List()
	if err != nil {
		return nil, err
	}
	out := make([]connectionInfo, 0, len(cfgs))
	for _, c := range cfgs {
		_, openErr := t.conns.Get(c.ID)
		out = append(out, connectionInfo{
			ID:        c.ID,
			Name:      c.Name,
			Kind:      c.Kind,
			Database:  c.Database,
			ReadOnly:  c.ReadOnly,
			Connected: openErr == nil,
		})
	}
	return out, nil
}

type databaseList struct {
	Supported bool     `json:"supported"`
	Databases []string `json:"databases"`
	Current   string   `json:"current,omitempty"`
}

func (t *Tools) listDatabases(ctx context.Context, cfg Config, args targetArgs) (databaseList, error) {
	tg, err := t.target(ctx, args.Connection, args.Database)
	if err != nil {
		return databaseList{}, err
	}
	l, ok := tg.open.Driver.(driver.DatabaseLister)
	if !ok {
		return databaseList{Supported: false, Databases: []string{}, Current: tg.database}, nil
	}
	dbs, err := l.ListDatabases(ctx, tg.open.DB)
	if err != nil {
		return databaseList{}, err
	}
	allowed := make([]string, 0, len(dbs))
	for _, db := range dbs {
		if cfg.AllowsDatabase(tg.cfg.Kind, db) {
			allowed = append(allowed, db)
		}
	}
	return databaseList{Supported: true, Databases: allowed, Current: tg.database}, nil
}

type schemaList struct {
	Schemas []string `json:"schemas"`
	Default string   `json:"default,omitempty"`
}

func (t *Tools) listSchemas(ctx context.Context, cfg Config, args targetArgs) (schemaList, error) {
	tg, err := t.target(ctx, args.Connection, args.Database)
	if err != nil {
		return schemaList{}, err
	}
	schemas, err := tg.open.Driver.ListSchemas(ctx, tg.open.DB)
	if err != nil {
		return schemaList{}, err
	}
	allowed := make([]string, 0, len(schemas))
	for _, schema := range schemas {
		if cfg.AllowsSchema(schema) {
			allowed = append(allowed, schema)
		}
	}
	def, _ := tg.open.Driver.DefaultSchema(ctx, tg.open.DB)
	if !cfg.AllowsSchema(def) {
		def = ""
	}
	return schemaList{Schemas: allowed, Default: def}, nil
}

func (t *Tools) listTables(ctx context.Context, cfg Config, args schemaArgs) ([]driver.Table, error) {
	schema, tg, err := t.schemaTarget(ctx, cfg, args)
	if err != nil {
		return nil, err
	}
	tables, err := tg.open.Driver.ListTables(ctx, tg.open.DB, schema)
	if err != nil {
		return nil, err
	}
	if tables == nil {
		tables = []driver.Table{}
	}
	return tables, nil
}

func (t *Tools) describeTable(ctx context.Context, cfg Config, args tableArgs) ([]driver.Column, error) {
	if strings.TrimSpace(args.Table) == "" {
		return nil, errors.New("a table name is required")
	}
	schema, tg, err := t.schemaTarget(ctx, cfg, args.schemaArgs)
	if err != nil {
		return nil, err
	}
	cols, err := tg.open.Driver.Columns(ctx, tg.open.DB, schema, args.Table)
	if err != nil {
		return nil, err
	}
	if cols == nil {
		cols = []driver.Column{}
	}
	return cols, nil
}

func (t *Tools) tableDDL(ctx context.Context, cfg Config, args ddlArgs) (string, error) {
	if strings.TrimSpace(args.Table) == "" {
		return "", errors.New("a table name is required")
	}
	kind := args.Type
	if kind == "" {
		kind = "table"
	}
	if kind != "table" && kind != "view" {
		return "", fmt.Errorf("unknown object kind %q", kind)
	}
	schema, tg, err := t.schemaTarget(ctx, cfg, args.schemaArgs)
	if err != nil {
		return "", err
	}
	return tg.open.Driver.TableDDL(ctx, tg.open.DB, schema, args.Table, kind)
}

// schemaTarget resolves the connection and the schema, defaulting it and
// enforcing the schema allow-list.
func (t *Tools) schemaTarget(ctx context.Context, cfg Config, args schemaArgs) (string, *target, error) {
	tg, err := t.target(ctx, args.Connection, args.Database)
	if err != nil {
		return "", nil, err
	}
	schema := strings.TrimSpace(args.Schema)
	if schema == "" {
		var err error
		if schema, err = tg.open.Driver.DefaultSchema(ctx, tg.open.DB); err != nil {
			return "", nil, err
		}
	}
	if !cfg.AllowsSchema(schema) {
		return "", nil, fmt.Errorf("schema %q is not allowed by the MCP permissions", schema)
	}
	return schema, tg, nil
}

func decodeArgs(raw json.RawMessage, dst any) error {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return fmt.Errorf("invalid arguments: %w", err)
	}
	return nil
}

func object(props map[string]any, required ...string) map[string]any {
	if props == nil {
		props = map[string]any{}
	}
	out := map[string]any{"type": "object", "properties": props, "additionalProperties": false}
	if len(required) > 0 {
		out["required"] = required
	}
	return out
}

func text(description string) map[string]any {
	return map[string]any{"type": "string", "description": description}
}

func number(description string, min, max int) map[string]any {
	return map[string]any{"type": "integer", "description": description, "minimum": min, "maximum": max}
}
