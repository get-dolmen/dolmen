package driver

import (
	"context"
	"database/sql"
	"strings"

	go_ora "github.com/sijms/go-ora/v2"
)

type oracle struct{}

func init() { register(oracle{}) }

func (oracle) Kind() Kind                 { return Oracle }
func (oracle) SQLDriverName() string      { return "oracle" }
func (oracle) QuoteIdent(n string) string { return quoteWith(n, `"`) }

// Oracle has no session-wide read-only switch, so every transaction on a
// read-only connection starts with SET TRANSACTION READ ONLY.
func (oracle) ReadOnlyTxStatement() string { return "SET TRANSACTION READ ONLY" }

func (oracle) DSN(cfg Config) (string, error) {
	host := cfg.Host
	if host == "" {
		host = "localhost"
	}
	port := cfg.Port
	if port == 0 {
		port = 1521
	}
	opts := map[string]string{}
	for k, v := range cfg.Options {
		opts[k] = v
	}
	return go_ora.BuildUrl(host, port, cfg.Database, cfg.User, cfg.Password, opts), nil
}

func (oracle) DefaultSchema(ctx context.Context, db *sql.DB) (string, error) {
	var s string
	err := db.QueryRowContext(ctx, "select sys_context('USERENV', 'CURRENT_SCHEMA') from dual").Scan(&s)
	return s, err
}

func (oracle) ListSchemas(ctx context.Context, db *sql.DB) ([]string, error) {
	// ORACLE_MAINTAINED exists from 12c; fall back to every user on older servers.
	s, err := queryStrings(ctx, db, `select username from all_users where oracle_maintained = 'N' order by username`)
	if err != nil {
		return queryStrings(ctx, db, `select username from all_users order by username`)
	}
	return s, nil
}

func (oracle) ListTables(ctx context.Context, db *sql.DB, schema string) ([]Table, error) {
	return queryTables(ctx, db, schema, `
		select table_name, 'TABLE' from all_tables where owner = :1 and nested = 'NO' and secondary = 'N'
		union all
		select view_name, 'VIEW' from all_views where owner = :2
		order by 1`, schema, schema)
}

func (oracle) Columns(ctx context.Context, db *sql.DB, schema, table string) ([]Column, error) {
	q := `
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
	args := []any{schema}
	if table != "" {
		q += " and c.table_name = :2"
		args = append(args, table)
	}
	q += " order by c.table_name, c.column_id"
	return queryColumns(ctx, db, q, args...)
}

func (oracle) TableDDL(ctx context.Context, db *sql.DB, schema, table, typ string) (string, error) {
	var ddl string
	err := db.QueryRowContext(ctx, "select dbms_metadata.get_ddl(:1, :2, :3) from dual",
		strings.ToUpper(typ), table, schema).Scan(&ddl)
	return strings.TrimSpace(ddl), err
}
