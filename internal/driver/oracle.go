package driver

import (
	"context"
	"database/sql"
	"strings"

	go_ora "github.com/sijms/go-ora/v2"
)

type oracle struct{}

func init() { register(oracle{}) }

func (oracle) Kind() Kind                    { return Oracle }
func (oracle) SQLDriverName() string         { return "oracle" }
func (oracle) QuoteIdent(name string) string { return quoteWith(name, `"`) }

// Oracle has no session-wide read-only switch, so every transaction on a
// read-only connection starts with SET TRANSACTION READ ONLY.
func (oracle) ReadOnlyTxStatement() string { return "SET TRANSACTION READ ONLY" }

func (oracle) DSN(config Config) (string, error) {
	host := config.Host
	if host == "" {
		host = "localhost"
	}
	port := config.Port
	if port == 0 {
		port = 1521
	}
	options := map[string]string{}
	for key, value := range config.Options {
		options[key] = value
	}
	return go_ora.BuildUrl(host, port, config.Database, config.User, config.Password, options), nil
}

func (oracle) DefaultSchema(ctx context.Context, db *sql.DB) (string, error) {
	var schemaName string
	err := db.QueryRowContext(ctx, "select sys_context('USERENV', 'CURRENT_SCHEMA') from dual").Scan(&schemaName)
	return schemaName, err
}

func (oracle) ListSchemas(ctx context.Context, db *sql.DB) ([]string, error) {
	// ORACLE_MAINTAINED exists from 12c; fall back to every user on older servers.
	usernames, err := queryStrings(ctx, db, `select username from all_users where oracle_maintained = 'N' order by username`)
	if err != nil {
		return queryStrings(ctx, db, `select username from all_users order by username`)
	}
	return usernames, nil
}

func (oracle) ListTables(ctx context.Context, db *sql.DB, schema string) ([]Table, error) {
	return queryTables(ctx, db, schema, `
		select table_name, 'TABLE' from all_tables where owner = :1 and nested = 'NO' and secondary = 'N'
		union all
		select view_name, 'VIEW' from all_views where owner = :2
		order by 1`, schema, schema)
}

func (oracle) Columns(ctx context.Context, db *sql.DB, schema, table string) ([]Column, error) {
	statement := `
		select c.table_name, c.column_name,
		       c.data_type || case
		         when c.data_type in ('VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR', 'RAW') then '(' || c.char_length || ')'
		         when c.data_type = 'NUMBER' and c.data_precision is not null then
		           '(' || c.data_precision || case when c.data_scale > 0 then ',' || c.data_scale end || ')'
		       end,
		       c.nullable,
		       case when exists (
		         select 1 from all_constraints k
		         join all_cons_columns kc on kc.owner = k.owner and kc.constraint_name = k.constraint_name
		         where k.constraint_type = 'P' and k.owner = c.owner
		           and k.table_name = c.table_name and kc.column_name = c.column_name
		       ) then 1 else 0 end
		from all_tab_columns c
		where c.owner = :1`
	arguments := []any{schema}
	if table != "" {
		statement += " and c.table_name = :2"
		arguments = append(arguments, table)
	}
	statement += " order by c.table_name, c.column_id"
	return queryColumns(ctx, db, statement, arguments...)
}

func (oracle) TableDDL(ctx context.Context, db *sql.DB, schema, table, objectType string) (string, error) {
	var definition string
	err := db.QueryRowContext(ctx, "select dbms_metadata.get_ddl(:1, :2, :3) from dual",
		strings.ToUpper(objectType), table, schema).Scan(&definition)
	return strings.TrimSpace(definition), err
}
