package tabledata

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"dolmen/internal/conn"
	"dolmen/internal/driver"
)

func openConnection(t *testing.T, readOnly bool, file string) *conn.Open {
	t.Helper()
	opened, err := conn.Dial(context.Background(), driver.Config{ID: "x", Name: "x", Kind: driver.SQLite, FilePath: file, ReadOnly: readOnly})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { opened.DB.Close() })
	return opened
}

func seed(t *testing.T) (string, *conn.Open) {
	file := filepath.Join(t.TempDir(), "d.db")
	opened := openConnection(t, false, file)
	_, err := opened.DB.Exec(`
		create table people (id integer primary key, name text not null, age integer, photo blob);
		create table nokey (a text);
		create view adults as select * from people where age >= 18;
		insert into people (id, name, age) values (1, 'Ada', 36), (2, 'Linus', 17), (3, 'Grace', 85), (4, 'Ken', null);`)
	if err != nil {
		t.Fatal(err)
	}
	return file, opened
}

func TestRead(t *testing.T) {
	ctx := context.Background()
	_, opened := seed(t)

	page, err := Read(ctx, opened, opened.DB, PageRequest{Schema: "main", Table: "people", Type: "table", Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if !page.Editable || !page.HasMore || len(page.Rows) != 2 || page.Rows[0][1] != "Ada" {
		t.Fatalf("first page: %+v", page)
	}
	if !page.Columns[0].PK || page.Columns[3].Editable {
		t.Errorf("column flags: %+v", page.Columns)
	}
	page, _ = Read(ctx, opened, opened.DB, PageRequest{Schema: "main", Table: "people", Type: "table", Limit: 2, Offset: 2})
	if page.HasMore || len(page.Rows) != 2 || page.Rows[1][2] != nil {
		t.Fatalf("second page: %+v", page.Rows)
	}
	page, err = Read(ctx, opened, opened.DB, PageRequest{Schema: "main", Table: "people", Type: "table", Where: "age > 30", OrderBy: "age desc"})
	if err != nil || len(page.Rows) != 2 || page.Rows[0][1] != "Grace" {
		t.Fatalf("filter/sort: %+v %v", page, err)
	}
	if rowCount, err := Count(ctx, opened, opened.DB, PageRequest{Schema: "main", Table: "people"}); err != nil || rowCount != 4 {
		t.Fatalf("count all: %databaseDriver %v", rowCount, err)
	}
	if rowCount, err := Count(ctx, opened, opened.DB, PageRequest{Schema: "main", Table: "people", Where: "age > 30"}); err != nil || rowCount != 2 {
		t.Fatalf("count filter: %databaseDriver %v", rowCount, err)
	}

	if page, _ := Read(ctx, opened, opened.DB, PageRequest{Schema: "main", Table: "adults", Type: "view"}); page.Editable || page.ReadOnly == "" {
		t.Error("views must not be editable")
	}
	if page, _ := Read(ctx, opened, opened.DB, PageRequest{Schema: "main", Table: "nokey", Type: "table"}); page.Editable {
		t.Error("tables without a primary key must not be editable")
	}
}

func TestApply(t *testing.T) {
	file, opened := seed(t)

	result, err := applyTx(t, opened, ApplyRequest{Schema: "main", Table: "people", Changes: []Change{
		{Op: "update", Key: map[string]any{"id": float64(1)}, Values: map[string]any{"name": "Ada L.", "age": "37"}},
		{Op: "update", Key: map[string]any{"id": float64(4)}, Values: map[string]any{"age": nil}},
		{Op: "delete", Key: map[string]any{"id": float64(2)}},
		{Op: "insert", Values: map[string]any{"id": "5", "name": "Barbara", "age": float64(70)}},
	}})
	if err != nil || *result != (ApplyResult{Inserted: 1, Updated: 2, Deleted: 1}) {
		t.Fatalf("apply: %+v %v", result, err)
	}
	var name string
	var age int
	opened.DB.QueryRow("select name, age from people where id = 1").Scan(&name, &age)
	if name != "Ada L." || age != 37 {
		t.Errorf("update not applied: %s %databaseDriver", name, age)
	}

	// A change that matches no row rolls back the whole batch.
	_, err = applyTx(t, opened, ApplyRequest{Schema: "main", Table: "people", Changes: []Change{
		{Op: "update", Key: map[string]any{"id": float64(3)}, Values: map[string]any{"name": "changed"}},
		{Op: "delete", Key: map[string]any{"id": float64(999)}},
	}})
	if err == nil || !strings.Contains(err.Error(), "matched 0 rows") {
		t.Fatalf("expected a conflict error, got %v", err)
	}
	opened.DB.QueryRow("select name from people where id = 3").Scan(&name)
	if name != "Grace" {
		t.Errorf("batch was not rolled back: %s", name)
	}

	// Unknown and binary columns are refused.
	for _, change := range []Change{
		{Op: "update", Key: map[string]any{"id": float64(1)}, Values: map[string]any{"nope": "x"}},
		{Op: "update", Key: map[string]any{"id": float64(1)}, Values: map[string]any{"photo": "0x00"}},
		{Op: "update", Key: map[string]any{}, Values: map[string]any{"name": "x"}},
	} {
		if _, err := applyTx(t, opened, ApplyRequest{Schema: "main", Table: "people", Changes: []Change{change}}); err == nil {
			t.Errorf("change %+v should be refused", change)
		}
	}

	// Read-only connections refuse every change.
	readOnlyConnection := openConnection(t, true, file)
	if _, err := applyTx(t, readOnlyConnection, ApplyRequest{Schema: "main", Table: "people", Changes: []Change{{Op: "delete", Key: map[string]any{"id": float64(1)}}}}); err == nil {
		t.Error("read-only connection accepted a change")
	}
}

func TestPostgresBind(t *testing.T) {
	statementBuilder := builder{kind: driver.Postgres, dialect: mustDriver(t, driver.Postgres), target: `"public"."t"`,
		columns:     map[string]Column{"id": {Name: "id", Type: "integer", PK: true, Editable: true}, "at": {Name: "at", Type: "timestamp with time zone", Editable: true}},
		primaryKeys: []Column{{Name: "id", Type: "integer", PK: true, Editable: true}}}
	sql, arguments, err := statementBuilder.build(Change{Op: "update", Key: map[string]any{"id": float64(7)}, Values: map[string]any{"at": "2024-03-01 10:00:00 +01:00"}})
	want := `UPDATE "public"."t" SET "at" = CAST($1 AS text)::timestamp with time zone WHERE "id" = CAST($2 AS text)::integer`
	if err != nil || sql != want || arguments[0] != "2024-03-01 10:00:00 +01:00" || arguments[1] != "7" {
		t.Fatalf("got %q %v %v", sql, arguments, err)
	}
}

func mustDriver(t *testing.T, kind driver.Kind) driver.Driver {
	databaseDriver, err := driver.Get(kind)
	if err != nil {
		t.Fatal(err)
	}
	return databaseDriver
}

// applyTx mirrors what the executor does in auto-commit mode.
func applyTx(t *testing.T, opened *conn.Open, request ApplyRequest) (*ApplyResult, error) {
	t.Helper()
	ctx := context.Background()
	tx, err := opened.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	result, err := Apply(ctx, opened, tx, request)
	if err != nil {
		return nil, err
	}
	return result, tx.Commit()
}
