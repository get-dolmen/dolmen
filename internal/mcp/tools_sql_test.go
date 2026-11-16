package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestReadQuery(t *testing.T) {
	tools, cfg := newSQLiteTools(t)
	cfg.Enabled = true
	res := call[queryResult](t, tools, "read_query",
		`{"connection":"local","sql":"select id, name from people order by id","maxRows":1}`)
	if len(res.Results) != 1 {
		t.Fatalf("results = %+v", res.Results)
	}
	got := res.Results[0]
	if len(got.Columns) != 2 || got.Columns[1].Name != "name" {
		t.Fatalf("columns = %+v", got.Columns)
	}
	if len(got.Rows) != 1 || got.Rows[0][1] != "Ada" {
		t.Fatalf("rows = %+v", got.Rows)
	}
	if !got.Truncated {
		t.Error("the output was not marked truncated")
	}
	if got.Error != "" {
		t.Fatalf("error = %s", got.Error)
	}

	// Read queries are recorded in the app's history.
	connections := call[[]connectionInfo](t, tools, "list_connections", "")
	entries, err := tools.historyStore.List(context.Background(), connections[0].ID, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Status != "ok" || !strings.Contains(entries[0].SQL, "select id, name") {
		t.Fatalf("history = %+v", entries)
	}
}

func TestReadQueryRefusesWrites(t *testing.T) {
	tools, cfg := newSQLiteTools(t)
	cfg.Enabled = true
	if _, err := tools.Call(context.Background(), "read_query",
		json.RawMessage(`{"connection":"local","sql":"delete from people"}`)); err == nil {
		t.Fatal("read_query accepted a DELETE")
	}
	if _, err := tools.Call(context.Background(), "write_query",
		json.RawMessage(`{"connection":"local","sql":"delete from people"}`)); err == nil {
		t.Fatal("write_query ran without write access")
	}
}

func TestWriteQueryCommitsAndRollsBack(t *testing.T) {
	tools, cfg := newSQLiteTools(t)
	cfg.Enabled = true
	cfg.Write = true

	res := call[queryResult](t, tools, "write_query",
		`{"connection":"local","sql":"insert into people (name) values ('Linus'); update people set name = 'Ada L.' where name = 'Ada'"}`)
	if !res.Committed || len(res.Results) != 2 {
		t.Fatalf("write = %+v", res)
	}
	for _, st := range res.Results {
		if st.Error != "" || st.RowsAffected != 1 {
			t.Fatalf("statement = %+v", st)
		}
	}

	after := call[queryResult](t, tools, "read_query",
		`{"connection":"local","sql":"select count(*) as n from people"}`)
	if n := after.Results[0].Rows[0][0]; n != int64(3) {
		t.Fatalf("count = %v (%T)", n, n)
	}

	// A failing statement rolls the whole call back.
	failed := call[queryResult](t, tools, "write_query",
		`{"connection":"local","sql":"insert into people (name) values ('Rolled back'); insert into missing values (1)"}`)
	if failed.Committed || len(failed.Results) != 2 || failed.Results[1].Error == "" {
		t.Fatalf("failed write = %+v", failed)
	}
	after = call[queryResult](t, tools, "read_query",
		`{"connection":"local","sql":"select count(*) as n from people"}`)
	if n := after.Results[0].Rows[0][0]; n != int64(3) {
		t.Fatalf("failed write changed the table: count = %v", n)
	}

	// Transaction control belongs to Dolmen, not to a tool call.
	if _, err := tools.Call(context.Background(), "write_query",
		json.RawMessage(`{"connection":"local","sql":"begin; insert into people (name) values ('x')"}`)); err == nil {
		t.Fatal("write_query accepted BEGIN")
	}
}

func TestQuerySchemaAllowList(t *testing.T) {
	tools, cfg := newSQLiteTools(t)
	cfg.Enabled = true
	cfg.Schemas = []string{"other"}
	if _, err := tools.Call(context.Background(), "read_query",
		json.RawMessage(`{"connection":"local","sql":"select * from main.people"}`)); err == nil {
		t.Fatal("a qualified table in a hidden schema was accepted")
	}
	// `people` is unqualified, but SQLite's main schema is also outside the
	// allow-list, and SQLite cannot swap its default schema: SQL is refused.
	if _, err := tools.Call(context.Background(), "read_query",
		json.RawMessage(`{"connection":"local","sql":"select * from people"}`)); err == nil {
		t.Fatal("unqualified SQL reached a hidden default schema")
	}
}

func TestQueryKeepsConnectionErrorsInResults(t *testing.T) {
	tools, cfg := newSQLiteTools(t)
	cfg.Enabled = true
	res := call[queryResult](t, tools, "read_query",
		`{"connection":"local","sql":"select * from missing"}`)
	if len(res.Results) != 1 || res.Results[0].Error == "" {
		t.Fatalf("results = %+v", res.Results)
	}
}
