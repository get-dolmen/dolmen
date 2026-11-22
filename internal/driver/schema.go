package driver

import (
	"context"
	"database/sql"
)

// SchemaSetter is implemented by engines whose sessions can switch the schema
// that unqualified names resolve to (Postgres, MySQL, Oracle). SQLite has no
// such setting: its schemas are attached files, always named explicitly.
type SchemaSetter interface {
	// SetSchema makes schema the session's current schema; "" restores the
	// connection's default.
	SetSchema(ctx context.Context, session *sql.Conn, config Config, schema string) error
}

// SetSchema points search_path at the schema, keeping public as a fallback so
// functions and types installed there by extensions still resolve. RESET
// returns to the value the session started with.
func (dialect postgres) SetSchema(ctx context.Context, session *sql.Conn, _ Config, schema string) error {
	statement := "RESET search_path"
	if schema != "" {
		statement = "SET search_path TO " + dialect.QuoteIdent(schema)
		if schema != "public" {
			statement += ", public"
		}
	}
	_, err := session.ExecContext(ctx, statement)
	return err
}

// SetSchema switches the default database (MySQL's schemas). MySQL cannot
// unset it, so "" returns to the connection's database when it has one and
// otherwise keeps the current one.
func (dialect mysqlDriver) SetSchema(ctx context.Context, session *sql.Conn, config Config, schema string) error {
	if schema == "" {
		schema = config.Database
	}
	if schema == "" {
		return nil
	}
	_, err := session.ExecContext(ctx, "USE "+dialect.QuoteIdent(schema))
	return err
}

// SetSchema sets CURRENT_SCHEMA; "" returns to the user the session logged in
// as. Schema names come from ALL_USERS with their exact case, hence quoted.
func (dialect oracle) SetSchema(ctx context.Context, session *sql.Conn, _ Config, schema string) error {
	if schema == "" {
		if err := session.QueryRowContext(ctx, "select sys_context('USERENV', 'SESSION_USER') from dual").Scan(&schema); err != nil {
			return err
		}
	}
	_, err := session.ExecContext(ctx, "ALTER SESSION SET CURRENT_SCHEMA = "+dialect.QuoteIdent(schema))
	return err
}
