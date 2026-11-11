//go:build integration

// Integration tests against real servers started with docker-compose.yml:
//
//	docker compose up -d
//	go test -tags integration ./internal/query/
//
// A database that is not reachable is skipped, not failed.
package query_test

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"

	"dolmen/internal/conn"
	"dolmen/internal/driver"
	"dolmen/internal/query"
)

var servers = []driver.Config{
	{ID: "pg", Name: "pg", Kind: driver.Postgres, Host: "localhost", Port: 55432, Database: "dolmen", User: "dolmen", Password: "dolmen", Options: map[string]string{"sslmode": "disable"}},
	{ID: "my", Name: "my", Kind: driver.MySQL, Host: "localhost", Port: 53306, Database: "dolmen", User: "dolmen", Password: "dolmen"},
	{ID: "ora", Name: "ora", Kind: driver.Oracle, Host: "localhost", Port: 51521, Database: "FREEPDB1", User: "dolmen", Password: "dolmen"},
}

func TestIntegration(t *testing.T) {
	for _, cfg := range servers {
		t.Run(string(cfg.Kind), func(t *testing.T) { testServer(t, cfg) })
	}
}

func testServer(t *testing.T, cfg driver.Config) {
	ctx := context.Background()
	m := conn.NewManager()
	defer m.CloseAll()
	o, err := m.Connect(ctx, cfg)
	if err != nil {
		t.Skipf("%s not reachable: %v", cfg.Kind, err)
	}
	e := query.NewExecutor(m, nil)
	defer e.CloseConnection(cfg.ID)

	exec := func(sql string) *query.ExecResponse {
		t.Helper()
		r, err := e.Execute(query.ExecRequest{TabID: "t", ConnID: cfg.ID, SQL: sql, Cursor: -1, MaxRows: 10})
		if err != nil {
			t.Fatal(err)
		}
		return r
	}

	// Fresh table with 25 rows.
	exec("drop table dolmen_it")
	r := exec("create table dolmen_it (id int primary key, name varchar(50), created date)")
	if r.Results[0].Error != "" {
		t.Fatalf("create: %s", r.Results[0].Error)
	}
	var b strings.Builder
	for i := 1; i <= 25; i++ {
		date := "date '2024-01-15'"
		b.WriteString("insert into dolmen_it values (" + strconv.Itoa(i) + ", 'n" + strconv.Itoa(i) + "', " + date + ");\n")
	}
	if cfg.Kind == driver.Oracle {
		exec(b.String() + "commit")
	} else {
		exec(b.String())
	}

	// Paging + fetch more.
	r = exec("select id, name, created from dolmen_it order by id")
	sel := r.Results[len(r.Results)-1]
	if sel.Error != "" || len(sel.Rows) != 10 || !sel.CanFetchMore {
		t.Fatalf("select: %+v", sel)
	}
	if got := sel.Rows[0][2]; got != "2024-01-15" {
		t.Errorf("date normalized to %#v", got)
	}
	f, err := e.FetchMore("t", sel.ID, 100)
	if err != nil || len(f.Rows) != 15 || f.HasMore {
		t.Fatalf("fetch more: %+v %v", f, err)
	}

	// Metadata.
	schema, err := o.Driver.DefaultSchema(ctx, o.DB)
	if err != nil || schema == "" {
		t.Fatalf("default schema %q: %v", schema, err)
	}
	tables, err := o.Driver.ListTables(ctx, o.DB, schema)
	if err != nil {
		t.Fatal(err)
	}
	name := "dolmen_it"
	if cfg.Kind == driver.Oracle {
		name = "DOLMEN_IT"
	}
	found := false
	for _, tb := range tables {
		found = found || tb.Name == name
	}
	if !found {
		t.Fatalf("%s not in %v", name, tables)
	}
	cols, err := o.Driver.Columns(ctx, o.DB, schema, name)
	if err != nil || len(cols) != 3 || !cols[0].PK {
		t.Fatalf("columns: %+v %v", cols, err)
	}
	if ddl, err := o.Driver.TableDDL(ctx, o.DB, schema, name, "table"); err != nil || ddl == "" {
		t.Fatalf("ddl: %q %v", ddl, err)
	}

	// Database level (Postgres): list databases, then query another one through its own pool.
	if l, ok := o.Driver.(driver.DatabaseLister); ok {
		dbs, err := l.ListDatabases(ctx, o.DB)
		if err != nil || len(dbs) < 2 || o.CurrentDB != "dolmen" {
			t.Fatalf("databases %v current %q: %v", dbs, o.CurrentDB, err)
		}
		other, err := m.GetDB(ctx, cfg.ID, "postgres")
		if err != nil || other == o {
			t.Fatalf("GetDB(postgres): %v", err)
		}
		if same, _ := m.GetDB(ctx, cfg.ID, "dolmen"); same != o {
			t.Error("GetDB of the current database should return the main pool")
		}
		r, err := e.Execute(query.ExecRequest{TabID: "t2", ConnID: cfg.ID, Database: "postgres", SQL: "select current_database()", Cursor: -1})
		if err != nil || r.Results[0].Rows[0][0] != "postgres" {
			t.Fatalf("execute on other database: %+v %v", r, err)
		}
	}

	// Cancellation of a long statement.
	slow := map[driver.Kind]string{
		driver.Postgres: "select pg_sleep(30)",
		driver.MySQL:    "select sleep(30)",
		driver.Oracle:   "select count(*) from all_objects a, all_objects b, all_objects c",
	}[cfg.Kind]
	go func() { time.Sleep(500 * time.Millisecond); e.Cancel("t") }()
	start := time.Now()
	r = exec(slow)
	if !r.Cancelled || time.Since(start) > 10*time.Second {
		t.Errorf("cancel: cancelled=%v after %v", r.Cancelled, time.Since(start))
	}

	// Session-level read-only: writes fail even when the statement guard is bypassed.
	ro := cfg
	ro.ID, ro.ReadOnly = cfg.ID+"-ro", true
	roOpen, err := conn.Dial(ctx, ro)
	if err != nil {
		t.Fatal(err)
	}
	defer roOpen.DB.Close()
	c, err := roOpen.DB.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if s := roOpen.Driver.ReadOnlyTxStatement(); s != "" {
		tx, err := c.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		if _, err := tx.ExecContext(ctx, s); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.ExecContext(ctx, "delete from dolmen_it"); err == nil {
			t.Error("delete succeeded inside a read-only transaction")
		}
	} else if _, err := c.ExecContext(ctx, "delete from dolmen_it"); err == nil {
		t.Error("delete succeeded on a read-only session")
	}
}
