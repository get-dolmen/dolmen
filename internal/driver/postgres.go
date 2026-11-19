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

func (postgres) Kind() Kind                    { return Postgres }
func (postgres) SQLDriverName() string         { return "pgx" }
func (postgres) ReadOnlyTxStatement() string   { return "" }
func (postgres) QuoteIdent(name string) string { return quoteWith(name, `"`) }

func (postgres) DSN(config Config) (string, error) {
	host := config.Host
	if host == "" {
		host = "localhost"
	}
	port := config.Port
	if port == 0 {
		port = 5432
	}
	target := url.URL{
		Scheme: "postgres",
		Host:   host + ":" + strconv.Itoa(port),
		Path:   "/" + config.Database,
	}
	if config.User != "" {
		target.User = url.UserPassword(config.User, config.Password)
	}
	parameters := url.Values{}
	parameters.Set("sslmode", "prefer")
	parameters.Set("application_name", "dolmen")
	for key, value := range config.Options {
		parameters.Set(key, value)
	}
	if config.ReadOnly {
		// Unknown parameters are sent by pgx as runtime parameters.
		parameters.Set("default_transaction_read_only", "on")
	}
	target.RawQuery = parameters.Encode()
	return target.String(), nil
}

func (postgres) ListDatabases(ctx context.Context, db *sql.DB) ([]string, error) {
	return queryStrings(ctx, db, `select datname from pg_catalog.pg_database
		where datallowconn and not datistemplate order by datname`)
}

func (postgres) CurrentDatabase(ctx context.Context, db *sql.DB) (string, error) {
	var name string
	err := db.QueryRowContext(ctx, "select current_database()").Scan(&name)
	return name, err
}

func (postgres) DefaultSchema(ctx context.Context, db *sql.DB) (string, error) {
	var schemaName sql.NullString
	err := db.QueryRowContext(ctx, "select current_schema()").Scan(&schemaName)
	if schemaName.String == "" {
		schemaName.String = "public"
	}
	return schemaName.String, err
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

func (postgres) ListForeignKeys(ctx context.Context, db *sql.DB, schema string) ([]ForeignKey, error) {
	return queryForeignKeys(ctx, db, `
		select con.conname,
		       n.nspname, c.relname, a.attname,
		       rn.nspname, rc.relname, ra.attname
		from pg_catalog.pg_constraint con
		join pg_catalog.pg_class c on c.oid = con.conrelid
		join pg_catalog.pg_namespace n on n.oid = c.relnamespace
		join pg_catalog.pg_class rc on rc.oid = con.confrelid
		join pg_catalog.pg_namespace rn on rn.oid = rc.relnamespace
		join unnest(con.conkey) with ordinality as k(attnum, ord) on true
		join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
		join unnest(con.confkey) with ordinality as rk(attnum, ord) on rk.ord = k.ord
		join pg_catalog.pg_attribute ra on ra.attrelid = rc.oid and ra.attnum = rk.attnum
		where con.contype = 'f' and n.nspname = $1
		order by c.relname, con.conname, k.ord`, schema)
}

func (dialect postgres) TableDDL(ctx context.Context, db *sql.DB, schema, table, objectType string) (string, error) {
	if objectType == "view" {
		var definition string
		err := db.QueryRowContext(ctx, `select pg_catalog.pg_get_viewdef(c.oid, true)
			from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
			where n.nspname = $1 and c.relname = $2`, schema, table).Scan(&definition)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("CREATE OR REPLACE VIEW %s.%s AS\n%s", dialect.QuoteIdent(schema), dialect.QuoteIdent(table), definition), nil
	}
	columns, err := dialect.Columns(ctx, db, schema, table)
	if err != nil {
		return "", err
	}
	return buildTableDDL(dialect, schema, table, columns), nil
}
