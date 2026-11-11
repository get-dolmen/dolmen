package driver

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"strconv"

	_ "github.com/jackc/pgx/v5/stdlib"
)

type postgres struct{}

func init() { register(postgres{}) }

func (postgres) Kind() Kind                  { return Postgres }
func (postgres) SQLDriverName() string       { return "pgx" }
func (postgres) ReadOnlyTxStatement() string { return "" }
func (postgres) QuoteIdent(n string) string  { return quoteWith(n, `"`) }

func (postgres) DSN(cfg Config) (string, error) {
	host := cfg.Host
	if host == "" {
		host = "localhost"
	}
	port := cfg.Port
	if port == 0 {
		port = 5432
	}
	u := url.URL{
		Scheme: "postgres",
		Host:   host + ":" + strconv.Itoa(port),
		Path:   "/" + cfg.Database,
	}
	if cfg.User != "" {
		u.User = url.UserPassword(cfg.User, cfg.Password)
	}
	q := url.Values{}
	q.Set("sslmode", "prefer")
	q.Set("application_name", "dolmen")
	for k, v := range cfg.Options {
		q.Set(k, v)
	}
	if cfg.ReadOnly {
		// Unknown parameters are sent by pgx as runtime parameters.
		q.Set("default_transaction_read_only", "on")
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func (postgres) ListDatabases(ctx context.Context, db *sql.DB) ([]string, error) {
	return queryStrings(ctx, db, `select datname from pg_catalog.pg_database
		where datallowconn and not datistemplate order by datname`)
}

func (postgres) CurrentDatabase(ctx context.Context, db *sql.DB) (string, error) {
	var s string
	err := db.QueryRowContext(ctx, "select current_database()").Scan(&s)
	return s, err
}

func (postgres) DefaultSchema(ctx context.Context, db *sql.DB) (string, error) {
	var s sql.NullString
	err := db.QueryRowContext(ctx, "select current_schema()").Scan(&s)
	if s.String == "" {
		s.String = "public"
	}
	return s.String, err
}

func (postgres) ListSchemas(ctx context.Context, db *sql.DB) ([]string, error) {
	return queryStrings(ctx, db, `
		select nspname from pg_catalog.pg_namespace
		where nspname not in ('pg_catalog', 'information_schema')
		  and nspname not like 'pg\_toast%' and nspname not like 'pg\_temp\_%'
		order by nspname`)
}

func (postgres) ListTables(ctx context.Context, db *sql.DB, schema string) ([]Table, error) {
	return queryTables(ctx, db, schema, `
		select c.relname,
		       case when c.relkind in ('v', 'm') then 'VIEW' else 'TABLE' end
		from pg_catalog.pg_class c
		join pg_catalog.pg_namespace n on n.oid = c.relnamespace
		where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm', 'f')
		order by c.relname`, schema)
}

func (postgres) Columns(ctx context.Context, db *sql.DB, schema, table string) ([]Column, error) {
	return queryColumns(ctx, db, `
		select c.relname, a.attname,
		       pg_catalog.format_type(a.atttypid, a.atttypmod),
		       not a.attnotnull,
		       exists (select 1 from pg_catalog.pg_index i
		               where i.indrelid = c.oid and i.indisprimary and a.attnum = any(i.indkey))
		from pg_catalog.pg_attribute a
		join pg_catalog.pg_class c on c.oid = a.attrelid
		join pg_catalog.pg_namespace n on n.oid = c.relnamespace
		where n.nspname = $1 and ($2::text = '' or c.relname = $2::text)
		  and c.relkind in ('r', 'p', 'v', 'm', 'f')
		  and a.attnum > 0 and not a.attisdropped
		order by c.relname, a.attnum`, schema, table)
}

func (d postgres) TableDDL(ctx context.Context, db *sql.DB, schema, table, typ string) (string, error) {
	if typ == "view" {
		var def string
		err := db.QueryRowContext(ctx, `select pg_catalog.pg_get_viewdef(c.oid, true)
			from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
			where n.nspname = $1 and c.relname = $2`, schema, table).Scan(&def)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("CREATE OR REPLACE VIEW %s.%s AS\n%s", d.QuoteIdent(schema), d.QuoteIdent(table), def), nil
	}
	cols, err := d.Columns(ctx, db, schema, table)
	if err != nil {
		return "", err
	}
	return buildTableDDL(d, schema, table, cols), nil
}
