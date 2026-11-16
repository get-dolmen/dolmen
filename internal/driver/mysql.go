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

func (mysqlDriver) Kind() Kind                    { return MySQL }
func (mysqlDriver) SQLDriverName() string         { return "mysql" }
func (mysqlDriver) ReadOnlyTxStatement() string   { return "" }
func (mysqlDriver) QuoteIdent(name string) string { return quoteWith(name, "`") }

func (mysqlDriver) DSN(config Config) (string, error) {
	host := config.Host
	if host == "" {
		host = "localhost"
	}
	port := config.Port
	if port == 0 {
		port = 3306
	}
	mysqlConfig := mysql.NewConfig()
	mysqlConfig.Net = "tcp"
	mysqlConfig.Addr = host + ":" + strconv.Itoa(port)
	mysqlConfig.User = config.User
	mysqlConfig.Passwd = config.Password
	mysqlConfig.DBName = config.Database
	mysqlConfig.ParseTime = true
	mysqlConfig.Loc = time.Local
	mysqlConfig.MultiStatements = false
	mysqlConfig.InterpolateParams = false
	mysqlConfig.Params = map[string]string{}
	for key, value := range config.Options {
		mysqlConfig.Params[key] = value
	}
	if config.ReadOnly {
		// Executed as SET transaction_read_only=1 on every new connection.
		mysqlConfig.Params["transaction_read_only"] = "1"
	}
	return mysqlConfig.FormatDSN(), nil
}

func (mysqlDriver) DefaultSchema(ctx context.Context, db *sql.DB) (string, error) {
	var schemaName sql.NullString
	err := db.QueryRowContext(ctx, "select database()").Scan(&schemaName)
	return schemaName.String, err
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

func (dialect mysqlDriver) TableDDL(ctx context.Context, db *sql.DB, schema, table, objectType string) (string, error) {
	keyword := "TABLE"
	if objectType == "view" {
		keyword = "VIEW"
	}
	rows, err := db.QueryContext(ctx, fmt.Sprintf("SHOW CREATE %s %s.%s", keyword, dialect.QuoteIdent(schema), dialect.QuoteIdent(table)))
	if err != nil {
		return "", err
	}
	defer rows.Close()
	columnNames, _ := rows.Columns()
	if !rows.Next() {
		return "", fmt.Errorf("no DDL returned for %s.%s", schema, table)
	}
	values := make([]sql.NullString, len(columnNames))
	destinations := make([]any, len(columnNames))
	for index := range values {
		destinations[index] = &values[index]
	}
	if err := rows.Scan(destinations...); err != nil {
		return "", err
	}
	return values[1].String + ";", nil
}
