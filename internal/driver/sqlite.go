package driver

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"

	_ "modernc.org/sqlite"
)

type sqliteDriver struct{}

func init() { register(sqliteDriver{}) }

func (sqliteDriver) Kind() Kind                  { return SQLite }
func (sqliteDriver) SQLDriverName() string       { return "sqlite" }
func (sqliteDriver) ReadOnlyTxStatement() string { return "" }
func (sqliteDriver) QuoteIdent(n string) string  { return quoteWith(n, `"`) }

func (sqliteDriver) DSN(cfg Config) (string, error) {
	if cfg.FilePath == "" {
		return "", errors.New("a database file is required")
	}
	q := url.Values{}
	q.Add("_pragma", "busy_timeout(5000)")
	q.Add("_pragma", "foreign_keys(1)")
	for k, v := range cfg.Options {
		q.Add(k, v)
	}
	if cfg.ReadOnly {
		q.Set("mode", "ro")
		q.Add("_pragma", "query_only(1)")
	}
	return "file:" + cfg.FilePath + "?" + q.Encode(), nil
}

func (sqliteDriver) DefaultSchema(context.Context, *sql.DB) (string, error) { return "main", nil }

func (sqliteDriver) ListSchemas(ctx context.Context, db *sql.DB) ([]string, error) {
	return queryStrings(ctx, db, `select name from pragma_database_list where name <> 'temp' order by seq`)
}

func (d sqliteDriver) ListTables(ctx context.Context, db *sql.DB, schema string) ([]Table, error) {
	return queryTables(ctx, db, schema, fmt.Sprintf(`
		select name, type from %s.sqlite_master
		where type in ('table', 'view') and name not like 'sqlite\_%%' escape '\'
		order by name`, d.QuoteIdent(schema)))
}

func (d sqliteDriver) Columns(ctx context.Context, db *sql.DB, schema, table string) ([]Column, error) {
	return queryColumns(ctx, db, fmt.Sprintf(`
		select m.name, p.name, p.type, p."notnull" = 0, p.pk > 0
		from %s.sqlite_master m
		join pragma_table_info(m.name, ?) p
		where m.type in ('table', 'view') and m.name not like 'sqlite\_%%' escape '\'
		  and (? = '' or m.name = ?)
		order by m.name, p.cid`, d.QuoteIdent(schema)), schema, table, table)
}

func (d sqliteDriver) TableDDL(ctx context.Context, db *sql.DB, schema, table, _ string) (string, error) {
	var s sql.NullString
	err := db.QueryRowContext(ctx, fmt.Sprintf(`select sql from %s.sqlite_master where name = ?`, d.QuoteIdent(schema)), table).Scan(&s)
	if err != nil {
		return "", err
	}
	return s.String + ";", nil
}
