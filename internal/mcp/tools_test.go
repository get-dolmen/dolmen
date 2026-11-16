package mcp

import (
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"dolmen/internal/conn"
	"dolmen/internal/driver"

	_ "modernc.org/sqlite"
)

// newSQLiteTools returns tools backed by a saved SQLite connection holding a
// small people table, plus the mutable policy the tools read.
func newSQLiteTools(t *testing.T) (*Tools, *Config) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "people.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`create table people (id integer primary key, name text not null);
		create view adults as select id, name from people;
		insert into people (name) values ('Ada'), ('Grace');`)
	if err != nil {
		db.Close()
		t.Fatal(err)
	}
	db.Close()

	store := conn.NewStore(dir)
	if _, err := store.Save(driver.Config{Name: "local", Kind: driver.SQLite, FilePath: path}); err != nil {
		t.Fatal(err)
	}
	manager := conn.NewManager()
	t.Cleanup(manager.CloseAll)
	cfg := DefaultConfig()
	cfg.Enabled = true
	return NewTools(manager, store, nil, func() Config { return cfg }), &cfg
}

func call[T any](t *testing.T, tools *Tools, name, args string) T {
	t.Helper()
	got, err := tools.Call(context.Background(), name, json.RawMessage(args))
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	value, ok := got.(T)
	if !ok {
		t.Fatalf("%s returned %T", name, got)
	}
	return value
}

func TestMetadataTools(t *testing.T) {
	tools, _ := newSQLiteTools(t)
	ctx := context.Background()

	connections, err := tools.Call(ctx, "list_connections", nil)
	if err != nil {
		t.Fatal(err)
	}
	list := connections.([]connectionInfo)
	if len(list) != 1 || list[0].Name != "local" || list[0].Kind != driver.SQLite {
		t.Fatalf("connections = %+v", list)
	}

	schemas := call[schemaList](t, tools, "list_schemas", `{"connection":"local"}`)
	if len(schemas.Schemas) != 1 || schemas.Schemas[0] != "main" || schemas.Default != "main" {
		t.Fatalf("schemas = %+v", schemas)
	}

	tables := call[[]driver.Table](t, tools, "list_tables", `{"connection":"local","schema":"main"}`)
	if len(tables) != 2 || tables[0].Name != "adults" || tables[1].Name != "people" {
		t.Fatalf("tables = %+v", tables)
	}

	cols := call[[]driver.Column](t, tools, "describe_table", `{"connection":"local","schema":"main","table":"people"}`)
	if len(cols) != 2 || cols[0].Name != "id" || !cols[0].PK {
		t.Fatalf("columns = %+v", cols)
	}

	ddl := call[string](t, tools, "get_table_ddl", `{"connection":"local","schema":"main","table":"people"}`)
	if !strings.Contains(strings.ToUpper(ddl), "CREATE TABLE") {
		t.Fatalf("ddl = %q", ddl)
	}
}

func TestMetadataToolsRespectPermissions(t *testing.T) {
	tools, cfg := newSQLiteTools(t)
	ctx := context.Background()

	cfg.Schemas = []string{"other"}
	if _, err := tools.Call(ctx, "list_tables", json.RawMessage(`{"connection":"local","schema":"main"}`)); err == nil {
		t.Fatal("a schema outside the allow-list was accepted")
	}
	if _, err := tools.Call(ctx, "list_schemas", json.RawMessage(`{"connection":"local"}`)); err != nil {
		t.Fatal(err)
	}
	// The schema list hides metadata the client may not touch.
	schemas := call[schemaList](t, tools, "list_schemas", `{"connection":"local"}`)
	if len(schemas.Schemas) != 0 || schemas.Default != "" {
		t.Fatalf("schemas = %+v", schemas)
	}

	cfg.Schemas = nil
	cfg.Databases = []string{"other.db"}
	if _, err := tools.Call(ctx, "list_tables", json.RawMessage(`{"connection":"local","schema":"main"}`)); err == nil {
		t.Fatal("a database outside the allow-list was accepted")
	}

	cfg.Databases = nil
	cfg.Read = false
	if _, err := tools.Call(ctx, "list_connections", nil); err == nil {
		t.Fatal("a read tool ran without read access")
	}

	cfg.Enabled = false
	cfg.Read = true
	if _, err := tools.Call(ctx, "list_connections", nil); err == nil {
		t.Fatal("a tool ran while the server was disabled")
	}
}

func TestUnknownConnectionAndTool(t *testing.T) {
	tools, _ := newSQLiteTools(t)
	ctx := context.Background()
	if _, err := tools.Call(ctx, "list_tables", json.RawMessage(`{"connection":"nope"}`)); err == nil {
		t.Fatal("an unknown connection was accepted")
	}
	if _, err := tools.Call(ctx, "drop_everything", nil); err == nil {
		t.Fatal("an unknown tool was accepted")
	}
}

func TestToolsListFollowsPermissions(t *testing.T) {
	tools, cfg := newSQLiteTools(t)
	names := func() []string {
		var out []string
		for _, tool := range tools.ListTools() {
			out = append(out, tool.Name)
		}
		return out
	}
	if got := strings.Join(names(), ","); got != "list_connections,list_databases,list_schemas,list_tables,describe_table,get_table_ddl" {
		t.Fatalf("read tools = %s", got)
	}
	cfg.Read = false
	if got := names(); len(got) != 0 {
		t.Fatalf("tools listed without read access: %v", got)
	}
}
