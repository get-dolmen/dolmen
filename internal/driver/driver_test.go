package driver

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

func TestDefaultPort(t *testing.T) {
	cases := map[Kind]int{
		Postgres: 5432,
		MySQL:    3306,
		Oracle:   1521,
		SQLite:   0,
	}
	for kind, want := range cases {
		if got := DefaultPort(kind); got != want {
			t.Errorf("DefaultPort(%s) = %d, want %d", kind, got, want)
		}
	}
}

func TestOracleDSN(t *testing.T) {
	dsn, err := oracle{}.DSN(Config{
		Host:     "db.example.com",
		Database: "ORCL",
		User:     "scott",
		Password: "tiger",
		Options: map[string]string{
			"SID":           "ORCL",
			"DBA PRIVILEGE": "SYSDBA",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"oracle://scott:tiger@db.example.com:1521/ORCL",
		"SID=ORCL",
		"DBA PRIVILEGE=SYSDBA",
	} {
		if !strings.Contains(dsn, want) {
			t.Errorf("DSN %q does not contain %q", dsn, want)
		}
	}
}

func TestOracleDSNPrefersExplicitPort(t *testing.T) {
	dsn, err := oracle{}.DSN(Config{Host: "db", Port: 1522, Database: "FREEPDB1", User: "u"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(dsn, ":1522/") {
		t.Errorf("DSN %q does not use port 1522", dsn)
	}
}

func TestSQLiteForeignKeys(t *testing.T) {
	file := filepath.Join(t.TempDir(), "fk.db")
	dsn, err := sqliteDriver{}.DSN(Config{FilePath: file})
	if err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := db.Exec(`
		create table accounts (id integer primary key);
		create table orders (
			id integer primary key,
			account_id integer references accounts(id),
			owner integer,
			constraint fk_owner foreign key (owner) references accounts(id)
		);`); err != nil {
		t.Fatal(err)
	}

	foreignKeys, err := sqliteDriver{}.ListForeignKeys(context.Background(), db, "main")
	if err != nil {
		t.Fatal(err)
	}
	if len(foreignKeys) != 2 {
		t.Fatalf("want 2 foreign-key columns, got %+v", foreignKeys)
	}
	want := map[string]bool{"account_id": true, "owner": true}
	constraints := map[string]bool{}
	for _, foreignKey := range foreignKeys {
		if foreignKey.Schema != "main" || foreignKey.Table != "orders" ||
			foreignKey.RefSchema != "main" || foreignKey.RefTable != "accounts" || foreignKey.RefColumn != "id" {
			t.Errorf("unexpected foreign key: %+v", foreignKey)
		}
		if !want[foreignKey.Column] {
			t.Errorf("unexpected column %q", foreignKey.Column)
		}
		if foreignKey.Constraint == "" || constraints[foreignKey.Constraint] {
			t.Errorf("constraint %q should uniquely name column %q", foreignKey.Constraint, foreignKey.Column)
		}
		constraints[foreignKey.Constraint] = true
	}
}
