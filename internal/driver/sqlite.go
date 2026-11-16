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

func (sqliteDriver) Kind() Kind                    { return SQLite }
func (sqliteDriver) SQLDriverName() string         { return "sqlite" }
func (sqliteDriver) ReadOnlyTxStatement() string   { return "" }
func (sqliteDriver) QuoteIdent(name string) string { return quoteWith(name, `"`) }

func (sqliteDriver) DSN(config Config) (string, error) {
	if config.FilePath == "" {
		return "", errors.New("a database file is required")
	}
	parameters := url.Values{}
	parameters.Add("_pragma", "busy_timeout(5000)")
	parameters.Add("_pragma", "foreign_keys(1)")
	for key, value := range config.Options {
		parameters.Add(key, value)
	}
	if config.ReadOnly {
		parameters.Set("mode", "ro")
		parameters.Add("_pragma", "query_only(1)")
	}
	return "file:" + config.FilePath + "?" + parameters.Encode(), nil
}

func (sqliteDriver) DefaultSchema(context.Context, *sql.DB) (string, error) { return "main", nil }

func (sqliteDriver) ListSchemas(ctx context.Context, db *sql.DB) ([]string, error) {
	return queryStrings(ctx, db, `select name from pragma_database_list where name <> 'temp' order by seq`)
}

func (dialect sqliteDriver) ListTables(ctx context.Context, db *sql.DB, schema string) ([]Table, error) {
	return queryTables(ctx, db, schema, fmt.Sprintf(`
		select name, type from %s.sqlite_master
		where type in ('table', 'view') and name not like 'sqlite\_%%' escape '\'
		order by name`, dialect.QuoteIdent(schema)))
}

func (dialect sqliteDriver) Columns(ctx context.Context, db *sql.DB, schema, table string) ([]Column, error) {
	return queryColumns(ctx, db, fmt.Sprintf(`
		select m.name, p.name, p.type, p."notnull" = 0, p.pk > 0
		from %s.sqlite_master m
		join pragma_table_info(m.name, ?) p
		where m.type in ('table', 'view') and m.name not like 'sqlite\_%%' escape '\'
		  and (? = '' or m.name = ?)
		order by m.name, p.cid`, dialect.QuoteIdent(schema)), schema, table, table)
}

func (dialect sqliteDriver) TableDDL(ctx context.Context, db *sql.DB, schema, table, _ string) (string, error) {
	var definition sql.NullString
	err := db.QueryRowContext(ctx, fmt.Sprintf(`select sql from %s.sqlite_master where name = ?`, dialect.QuoteIdent(schema)), table).Scan(&definition)
	if err != nil {
		return "", err
	}
	return definition.String + ";", nil
}
