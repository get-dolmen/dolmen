// Package driver abstracts the database-specific parts of Dolmen:
// DSN building, read-only session setup and metadata queries.
package driver

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strings"
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
	Options  map[string]string `json:"options,omitempty"` // extra DSN parameters
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
	DSN(cfg Config) (string, error)
	// ReadOnlyTxStatement returns a statement that must open every
	// transaction on a read-only connection ("" if the DSN already covers it).
	ReadOnlyTxStatement() string
	DefaultSchema(ctx context.Context, db *sql.DB) (string, error)
	ListSchemas(ctx context.Context, db *sql.DB) ([]string, error)
	ListTables(ctx context.Context, db *sql.DB, schema string) ([]Table, error)
	// Columns lists the columns of one table, or of every table in the
	// schema when table is "".
	Columns(ctx context.Context, db *sql.DB, schema, table string) ([]Column, error)
	TableDDL(ctx context.Context, db *sql.DB, schema, table, typ string) (string, error)
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

func register(d Driver) { registry[d.Kind()] = d }

// Get returns the driver for a kind.
func Get(k Kind) (Driver, error) {
	d, ok := registry[k]
	if !ok {
		return nil, fmt.Errorf("unsupported database kind %q", k)
	}
	return d, nil
}

// --- helpers shared by implementations ---

func queryStrings(ctx context.Context, db *sql.DB, q string, args ...any) ([]string, error) {
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func queryTables(ctx context.Context, db *sql.DB, schema, q string, args ...any) ([]Table, error) {
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Table
	for rows.Next() {
		var name, typ string
		if err := rows.Scan(&name, &typ); err != nil {
			return nil, err
		}
		t := "table"
		if strings.Contains(strings.ToUpper(typ), "VIEW") {
			t = "view"
		}
		out = append(out, Table{Schema: schema, Name: name, Type: t})
	}
	return out, rows.Err()
}

// queryColumns expects rows of (table, column, type, nullable bool-ish, pk bool-ish).
func queryColumns(ctx context.Context, db *sql.DB, q string, args ...any) ([]Column, error) {
	rows, err := db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Column
	for rows.Next() {
		var c Column
		var nullable, pk any
		if err := rows.Scan(&c.Table, &c.Name, &c.Type, &nullable, &pk); err != nil {
			return nil, err
		}
		c.Nullable = truthy(nullable)
		c.PK = truthy(pk)
		out = append(out, c)
	}
	return out, rows.Err()
}

func truthy(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case int64:
		return x != 0
	case float64:
		return x != 0
	case []byte:
		return truthy(string(x))
	case string:
		switch strings.ToUpper(strings.TrimSpace(x)) {
		case "1", "Y", "YES", "TRUE", "T":
			return true
		}
	}
	return false
}

// buildTableDDL renders a basic CREATE TABLE for engines without a native DDL export.
func buildTableDDL(d Driver, schema, table string, cols []Column) string {
	var lines, pks []string
	for _, c := range cols {
		l := "    " + d.QuoteIdent(c.Name) + " " + c.Type
		if !c.Nullable {
			l += " NOT NULL"
		}
		lines = append(lines, l)
		if c.PK {
			pks = append(pks, d.QuoteIdent(c.Name))
		}
	}
	if len(pks) > 0 {
		lines = append(lines, "    PRIMARY KEY ("+strings.Join(pks, ", ")+")")
	}
	return fmt.Sprintf("CREATE TABLE %s.%s (\n%s\n);", d.QuoteIdent(schema), d.QuoteIdent(table), strings.Join(lines, ",\n"))
}

func sortTables(ts []Table) {
	sort.Slice(ts, func(i, j int) bool { return strings.ToLower(ts[i].Name) < strings.ToLower(ts[j].Name) })
}

func quoteWith(name, q string) string {
	return q + strings.ReplaceAll(name, q, q+q) + q
}
