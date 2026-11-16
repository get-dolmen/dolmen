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
	connections      *conn.Manager
	savedConnections *conn.Store
	historyStore     *history.Store
	policy           func() Config
}

func NewTools(connections *conn.Manager, savedConnections *conn.Store, historyStore *history.Store, policy func() Config) *Tools {
	return &Tools{connections: connections, savedConnections: savedConnections, historyStore: historyStore, policy: policy}
}

// Tool is one entry of the MCP tools/list result.
type Tool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

// ListTools describes the tools available under the current permissions.
func (t *Tools) ListTools() []Tool {
	config := t.config()
	if !config.AllowsRead() {
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
	if config.AllowsWrite() {
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
	config := t.config()
	if !config.Enabled {
		return nil, errors.New("the MCP server is disabled")
	}
	switch name {
	case "list_connections":
		if err := requireRead(config); err != nil {
			return nil, err
		}
		return t.listConnections()
	case "list_databases":
		if err := requireRead(config); err != nil {
			return nil, err
		}
		var args targetArgs
		if err := decodeArgs(raw, &args); err != nil {
			return nil, err
		}
		return t.listDatabases(ctx, config, args)
	case "list_schemas":
		if err := requireRead(config); err != nil {
			return nil, err
		}
		var args targetArgs
		if err := decodeArgs(raw, &args); err != nil {
			return nil, err
		}
		return t.listSchemas(ctx, config, args)
	case "list_tables":
		if err := requireRead(config); err != nil {
			return nil, err
		}
		var args schemaArgs
		if err := decodeArgs(raw, &args); err != nil {
			return nil, err
		}
		return t.listTables(ctx, config, args)
	case "describe_table":
		if err := requireRead(config); err != nil {
			return nil, err
		}
		var args tableArgs
		if err := decodeArgs(raw, &args); err != nil {
			return nil, err
		}
		return t.describeTable(ctx, config, args)
	case "get_table_ddl":
		if err := requireRead(config); err != nil {
			return nil, err
		}
		var args ddlArgs
		if err := decodeArgs(raw, &args); err != nil {
			return nil, err
		}
		return t.tableDDL(ctx, config, args)
	case "read_query":
		if err := requireRead(config); err != nil {
			return nil, err
		}
		var args queryArgs
		if err := decodeArgs(raw, &args); err != nil {
			return nil, err
		}
		return t.readQuery(ctx, config, args)
	case "write_query":
		if err := requireWrite(config); err != nil {
			return nil, err
		}
		var args queryArgs
		if err := decodeArgs(raw, &args); err != nil {
			return nil, err
		}
		return t.writeQuery(ctx, config, args)
	}
	return nil, fmt.Errorf("unknown tool %q", name)
}

func (t *Tools) config() Config {
	if t.policy == nil {
		return DefaultConfig()
	}
	return t.policy()
}

func requireRead(config Config) error {
	if !config.AllowsRead() {
		return errors.New("reading is disabled in Dolmen's MCP settings")
	}
	return nil
}

func requireWrite(config Config) error {
	if !config.AllowsWrite() {
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
	config   driver.Config
	opened   *conn.Open
	database string
}

func (t *Tools) target(ctx context.Context, reference, database string) (*target, error) {
	config, err := t.savedConnection(reference)
	if err != nil {
		return nil, err
	}
	policy := t.config()
	database = strings.TrimSpace(database)
	if database == "" {
		database = config.Database
	}
	if !policy.AllowsDatabase(config.Kind, database) {
		return nil, fmt.Errorf("database %q is not allowed by the MCP permissions", database)
	}
	opened, err := t.connections.Get(config.ID)
	if err != nil {
		// Saved connections are opened on demand, so clients do not need the
		// user to connect first.
		opened, err = t.connections.Connect(ctx, config)
		if err != nil {
			return nil, fmt.Errorf("connecting to %s: %w", config.Name, err)
		}
	}
	if database != "" && database != opened.CurrentDB {
		opened, err = t.connections.GetDB(ctx, config.ID, database)
		if err != nil {
			return nil, err
		}
	}
	actual := databaseName(config, opened)
	if !policy.AllowsDatabase(config.Kind, actual) {
		return nil, fmt.Errorf("database %q is not allowed by the MCP permissions", actual)
	}
	return &target{config: config, opened: opened, database: actual}, nil
}

// savedConnection resolves a connection by id or by unique name.
func (t *Tools) savedConnection(reference string) (driver.Config, error) {
	reference = strings.TrimSpace(reference)
	if reference == "" {
		return driver.Config{}, errors.New("a connection name or id is required")
	}
	configs, err := t.savedConnections.List()
	if err != nil {
		return driver.Config{}, err
	}
	for _, config := range configs {
		if config.ID == reference {
			return config, nil
		}
	}
	var found *driver.Config
	for i := range configs {
		if strings.EqualFold(configs[i].Name, reference) {
			if found != nil {
				return driver.Config{}, fmt.Errorf("connection name %q is ambiguous; use its id", reference)
			}
			found = &configs[i]
		}
	}
	if found == nil {
		return driver.Config{}, fmt.Errorf("connection %q not found", reference)
	}
	return *found, nil
}

// databaseName is the database a pool is bound to, or the SQLite file's name.
func databaseName(config driver.Config, opened *conn.Open) string {
	if opened.CurrentDB != "" {
		return opened.CurrentDB
	}
	if config.Database != "" {
		return config.Database
	}
	if config.Kind == driver.SQLite {
		return filepath.Base(config.FilePath)
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
	configs, err := t.savedConnections.List()
	if err != nil {
		return nil, err
	}
	result := make([]connectionInfo, 0, len(configs))
	for _, config := range configs {
		_, openErr := t.connections.Get(config.ID)
		result = append(result, connectionInfo{
			ID:        config.ID,
			Name:      config.Name,
			Kind:      config.Kind,
			Database:  config.Database,
			ReadOnly:  config.ReadOnly,
			Connected: openErr == nil,
		})
	}
	return result, nil
}

type databaseList struct {
	Supported bool     `json:"supported"`
	Databases []string `json:"databases"`
	Current   string   `json:"current,omitempty"`
}

func (t *Tools) listDatabases(ctx context.Context, config Config, args targetArgs) (databaseList, error) {
	connection, err := t.target(ctx, args.Connection, args.Database)
	if err != nil {
		return databaseList{}, err
	}
	lister, ok := connection.opened.Driver.(driver.DatabaseLister)
	if !ok {
		return databaseList{Supported: false, Databases: []string{}, Current: connection.database}, nil
	}
	databases, err := lister.ListDatabases(ctx, connection.opened.DB)
	if err != nil {
		return databaseList{}, err
	}
	allowed := make([]string, 0, len(databases))
	for _, database := range databases {
		if config.AllowsDatabase(connection.config.Kind, database) {
			allowed = append(allowed, database)
		}
	}
	return databaseList{Supported: true, Databases: allowed, Current: connection.database}, nil
}

type schemaList struct {
	Schemas []string `json:"schemas"`
	Default string   `json:"default,omitempty"`
}

func (t *Tools) listSchemas(ctx context.Context, config Config, args targetArgs) (schemaList, error) {
	connection, err := t.target(ctx, args.Connection, args.Database)
	if err != nil {
		return schemaList{}, err
	}
	schemas, err := connection.opened.Driver.ListSchemas(ctx, connection.opened.DB)
	if err != nil {
		return schemaList{}, err
	}
	allowed := make([]string, 0, len(schemas))
	for _, schema := range schemas {
		if config.AllowsSchema(schema) {
			allowed = append(allowed, schema)
		}
	}
	defaultSchema, _ := connection.opened.Driver.DefaultSchema(ctx, connection.opened.DB)
	if !config.AllowsSchema(defaultSchema) {
		defaultSchema = ""
	}
	return schemaList{Schemas: allowed, Default: defaultSchema}, nil
}

func (t *Tools) listTables(ctx context.Context, config Config, args schemaArgs) ([]driver.Table, error) {
	schema, connection, err := t.schemaTarget(ctx, config, args)
	if err != nil {
		return nil, err
	}
	tables, err := connection.opened.Driver.ListTables(ctx, connection.opened.DB, schema)
	if err != nil {
		return nil, err
	}
	if tables == nil {
		tables = []driver.Table{}
	}
	return tables, nil
}

func (t *Tools) describeTable(ctx context.Context, config Config, args tableArgs) ([]driver.Column, error) {
	if strings.TrimSpace(args.Table) == "" {
		return nil, errors.New("a table name is required")
	}
	schema, connection, err := t.schemaTarget(ctx, config, args.schemaArgs)
	if err != nil {
		return nil, err
	}
	columns, err := connection.opened.Driver.Columns(ctx, connection.opened.DB, schema, args.Table)
	if err != nil {
		return nil, err
	}
	if columns == nil {
		columns = []driver.Column{}
	}
	return columns, nil
}

func (t *Tools) tableDDL(ctx context.Context, config Config, args ddlArgs) (string, error) {
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
	schema, connection, err := t.schemaTarget(ctx, config, args.schemaArgs)
	if err != nil {
		return "", err
	}
	return connection.opened.Driver.TableDDL(ctx, connection.opened.DB, schema, args.Table, kind)
}

// schemaTarget resolves the connection and the schema, defaulting it and
// enforcing the schema allow-list.
func (t *Tools) schemaTarget(ctx context.Context, config Config, args schemaArgs) (string, *target, error) {
	connection, err := t.target(ctx, args.Connection, args.Database)
	if err != nil {
		return "", nil, err
	}
	schema := strings.TrimSpace(args.Schema)
	if schema == "" {
		var err error
		if schema, err = connection.opened.Driver.DefaultSchema(ctx, connection.opened.DB); err != nil {
			return "", nil, err
		}
	}
	if !config.AllowsSchema(schema) {
		return "", nil, fmt.Errorf("schema %q is not allowed by the MCP permissions", schema)
	}
	return schema, connection, nil
}

func decodeArgs(raw json.RawMessage, destination any) error {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	if err := json.Unmarshal(raw, destination); err != nil {
		return fmt.Errorf("invalid arguments: %w", err)
	}
	return nil
}

func object(properties map[string]any, required ...string) map[string]any {
	if properties == nil {
		properties = map[string]any{}
	}
	result := map[string]any{"type": "object", "properties": properties, "additionalProperties": false}
	if len(required) > 0 {
		result["required"] = required
	}
	return result
}

func text(description string) map[string]any {
	return map[string]any{"type": "string", "description": description}
}

func number(description string, minimum, maximum int) map[string]any {
	return map[string]any{"type": "integer", "description": description, "minimum": minimum, "maximum": maximum}
}
