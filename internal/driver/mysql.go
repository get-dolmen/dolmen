package driver

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"
	"time"

	"github.com/go-sql-driver/mysql"
)

type mysqlDriver struct{}

func init() { register(mysqlDriver{}) }

func (mysqlDriver) Kind() Kind                  { return MySQL }
func (mysqlDriver) SQLDriverName() string       { return "mysql" }
func (mysqlDriver) ReadOnlyTxStatement() string { return "" }
func (mysqlDriver) QuoteIdent(n string) string  { return quoteWith(n, "`") }

func (mysqlDriver) DSN(cfg Config) (string, error) {
	host := cfg.Host
	if host == "" {
		host = "localhost"
	}
	port := cfg.Port
	if port == 0 {
		port = 3306
	}
	c := mysql.NewConfig()
	c.Net = "tcp"
	c.Addr = host + ":" + strconv.Itoa(port)
	c.User = cfg.User
	c.Passwd = cfg.Password
	c.DBName = cfg.Database
	c.ParseTime = true
	c.Loc = time.Local
	c.MultiStatements = false
	c.InterpolateParams = false
	c.Params = map[string]string{}
	for k, v := range cfg.Options {
		c.Params[k] = v
	}
	if cfg.ReadOnly {
		// Executed as SET transaction_read_only=1 on every new connection.
		c.Params["transaction_read_only"] = "1"
	}
	return c.FormatDSN(), nil
}

func (mysqlDriver) DefaultSchema(ctx context.Context, db *sql.DB) (string, error) {
	var s sql.NullString
	err := db.QueryRowContext(ctx, "select database()").Scan(&s)
	return s.String, err
}

func (mysqlDriver) ListSchemas(ctx context.Context, db *sql.DB) ([]string, error) {
	return queryStrings(ctx, db, `
		select schema_name from information_schema.schemata
		where schema_name not in ('information_schema', 'performance_schema', 'mysql', 'sys')
		order by schema_name`)
}

func (mysqlDriver) ListTables(ctx context.Context, db *sql.DB, schema string) ([]Table, error) {
	return queryTables(ctx, db, schema, `
		select table_name, table_type from information_schema.tables
		where table_schema = ? order by table_name`, schema)
}

func (mysqlDriver) Columns(ctx context.Context, db *sql.DB, schema, table string) ([]Column, error) {
	return queryColumns(ctx, db, `
		select table_name, column_name, column_type,
		       is_nullable = 'YES', column_key = 'PRI'
		from information_schema.columns
		where table_schema = ? and (? = '' or table_name = ?)
		order by table_name, ordinal_position`, schema, table, table)
}

func (d mysqlDriver) TableDDL(ctx context.Context, db *sql.DB, schema, table, typ string) (string, error) {
	kw := "TABLE"
	if typ == "view" {
		kw = "VIEW"
	}
	rows, err := db.QueryContext(ctx, fmt.Sprintf("SHOW CREATE %s %s.%s", kw, d.QuoteIdent(schema), d.QuoteIdent(table)))
	if err != nil {
		return "", err
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	if !rows.Next() {
		return "", fmt.Errorf("no DDL returned for %s.%s", schema, table)
	}
	vals := make([]sql.NullString, len(cols))
	ptrs := make([]any, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	if err := rows.Scan(ptrs...); err != nil {
		return "", err
	}
	return vals[1].String + ";", nil
}
