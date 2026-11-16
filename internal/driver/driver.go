// Package driver abstracts the database-specific parts of Dolmen:
// DSN building, read-only session setup and metadata queries.
package driver

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strings"

	"dolmen/internal/sshtunnel"
)

// Kind identifies a supported database engine.
type Kind string

const (
	Postgres Kind = "postgres"
	MySQL    Kind = "mysql"
	Oracle   Kind = "oracle"
	SQLite   Kind = "sqlite"
)

// Config is a saved connection definition.
type Config struct {
	ID       string            `json:"id"`
	Name     string            `json:"name"`
	Kind     Kind              `json:"kind"`
	Host     string            `json:"host,omitempty"`
	Port     int               `json:"port,omitempty"`
	Database string            `json:"database,omitempty"` // PG/MySQL database, Oracle service name
	User     string            `json:"user,omitempty"`
	Password string            `json:"password,omitempty"`
	FilePath string            `json:"filePath,omitempty"` // SQLite
	ReadOnly bool              `json:"readOnly"`
	Color    string            `json:"color,omitempty"`
	FolderID string            `json:"folderId,omitempty"` // explorer folder
	Options  map[string]string `json:"options,omitempty"`  // extra DSN parameters
	// SSH tunnels the database connection through a jump host; nil or
	// disabled connects directly.
	SSH *sshtunnel.Config `json:"ssh,omitempty"`
	// UpdatedAt is the unix-ms time of the last local change. Git sync uses it
	// to pick the newest copy of a connection.
	UpdatedAt int64 `json:"updatedAt,omitempty"`
}

// Table is a table or view inside a schema.
type Table struct {
	Schema string `json:"schema"`
	Name   string `json:"name"`
	Type   string `json:"type"` // "table" | "view"
}

// Column describes a column of a table or view.
type Column struct {
	Table    string `json:"table"`
	Name     string `json:"name"`
	Type     string `json:"type"`
	Nullable bool   `json:"nullable"`
	PK       bool   `json:"pk"`
}

// Driver is implemented once per database engine.
type Driver interface {
	Kind() Kind
	// SQLDriverName is the name registered with database/sql.
	SQLDriverName() string
	// DSN builds the data source name; read-only connections get
	// session-level protection here whenever the engine supports it.
	DSN(config Config) (string, error)
	// ReadOnlyTxStatement returns a statement that must open every
	// transaction on a read-only connection ("" if the DSN already covers it).
	ReadOnlyTxStatement() string
	DefaultSchema(ctx context.Context, db *sql.DB) (string, error)
	ListSchemas(ctx context.Context, db *sql.DB) ([]string, error)
	ListTables(ctx context.Context, db *sql.DB, schema string) ([]Table, error)
	// Columns lists the columns of one table, or of every table in the
	// schema when table is "".
	Columns(ctx context.Context, db *sql.DB, schema, table string) ([]Column, error)
	TableDDL(ctx context.Context, db *sql.DB, schema, table, objectType string) (string, error)
	QuoteIdent(name string) string
}

// DatabaseLister is implemented by engines where a connection is bound to a
// single database (Postgres). Dolmen then shows a database level in the
// explorer and opens one pool per database the user browses.
type DatabaseLister interface {
	ListDatabases(ctx context.Context, db *sql.DB) ([]string, error)
	CurrentDatabase(ctx context.Context, db *sql.DB) (string, error)
}

var registry = map[Kind]Driver{}

func register(databaseDriver Driver) { registry[databaseDriver.Kind()] = databaseDriver }

// Get returns the driver for a kind.
func Get(kind Kind) (Driver, error) {
	databaseDriver, ok := registry[kind]
	if !ok {
		return nil, fmt.Errorf("unsupported database kind %q", kind)
	}
	return databaseDriver, nil
}

// DefaultPort returns the port a config uses when it leaves Port empty.
func DefaultPort(kind Kind) int {
	switch kind {
	case Postgres:
		return 5432
	case MySQL:
		return 3306
	case Oracle:
		return 1521
	}
	return 0
}

// --- helpers shared by implementations ---

func queryStrings(ctx context.Context, db *sql.DB, query string, arguments ...any) ([]string, error) {
	rows, err := db.QueryContext(ctx, query, arguments...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		names = append(names, name)
	}
	return names, rows.Err()
}

func queryTables(ctx context.Context, db *sql.DB, schema, query string, arguments ...any) ([]Table, error) {
	rows, err := db.QueryContext(ctx, query, arguments...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tables []Table
	for rows.Next() {
		var name, typeName string
		if err := rows.Scan(&name, &typeName); err != nil {
			return nil, err
		}
		tableType := "table"
		if strings.Contains(strings.ToUpper(typeName), "VIEW") {
			tableType = "view"
		}
		tables = append(tables, Table{Schema: schema, Name: name, Type: tableType})
	}
	return tables, rows.Err()
}

// queryColumns expects rows of (table, column, type, nullable bool-ish, pk bool-ish).
func queryColumns(ctx context.Context, db *sql.DB, query string, arguments ...any) ([]Column, error) {
	rows, err := db.QueryContext(ctx, query, arguments...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var columns []Column
	for rows.Next() {
		var column Column
		var nullable, primaryKey any
		if err := rows.Scan(&column.Table, &column.Name, &column.Type, &nullable, &primaryKey); err != nil {
			return nil, err
		}
		column.Nullable = truthy(nullable)
		column.PK = truthy(primaryKey)
		columns = append(columns, column)
	}
	return columns, rows.Err()
}

func truthy(value any) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case int64:
		return typed != 0
	case float64:
		return typed != 0
	case []byte:
		return truthy(string(typed))
	case string:
		switch strings.ToUpper(strings.TrimSpace(typed)) {
		case "1", "Y", "YES", "TRUE", "T":
			return true
		}
	}
	return false
}

// buildTableDDL renders a basic CREATE TABLE for engines without a native DDL export.
func buildTableDDL(databaseDriver Driver, schema, table string, columns []Column) string {
	var lines, primaryKeys []string
	for _, column := range columns {
		line := "    " + databaseDriver.QuoteIdent(column.Name) + " " + column.Type
		if !column.Nullable {
			line += " NOT NULL"
		}
		lines = append(lines, line)
		if column.PK {
			primaryKeys = append(primaryKeys, databaseDriver.QuoteIdent(column.Name))
		}
	}
	if len(primaryKeys) > 0 {
		lines = append(lines, "    PRIMARY KEY ("+strings.Join(primaryKeys, ", ")+")")
	}
	return fmt.Sprintf("CREATE TABLE %s.%s (\n%s\n);", databaseDriver.QuoteIdent(schema), databaseDriver.QuoteIdent(table), strings.Join(lines, ",\n"))
}

func sortTables(tables []Table) {
	sort.Slice(tables, func(left, right int) bool {
		return strings.ToLower(tables[left].Name) < strings.ToLower(tables[right].Name)
	})
}

func quoteWith(name, quote string) string {
	return quote + strings.ReplaceAll(name, quote, quote+quote) + quote
}
