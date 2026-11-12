package tabledata

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"dolmen/internal/conn"
	"dolmen/internal/driver"
)

func open(t *testing.T, readOnly bool, file string) *conn.Open {
	t.Helper()
	o, err := conn.Dial(context.Background(), driver.Config{ID: "x", Name: "x", Kind: driver.SQLite, FilePath: file, ReadOnly: readOnly})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { o.DB.Close() })
	return o
}

func seed(t *testing.T) (string, *conn.Open) {
	file := filepath.Join(t.TempDir(), "d.db")
	o := open(t, false, file)
	_, err := o.DB.Exec(`
		create table people (id integer primary key, name text not null, age integer, photo blob);
		create table nokey (a text);
		create view adults as select * from people where age >= 18;
		insert into people (id, name, age) values (1, 'Ada', 36), (2, 'Linus', 17), (3, 'Grace', 85), (4, 'Ken', null);`)
	if err != nil {
		t.Fatal(err)
	}
	return file, o
}

func TestRead(t *testing.T) {
	ctx := context.Background()
	_, o := seed(t)

	p, err := Read(ctx, o, o.DB, PageRequest{Schema: "main", Table: "people", Type: "table", Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if !p.Editable || !p.HasMore || len(p.Rows) != 2 || p.Rows[0][1] != "Ada" {
		t.Fatalf("first page: %+v", p)
	}
	if !p.Columns[0].PK || p.Columns[3].Editable {
		t.Errorf("column flags: %+v", p.Columns)
	}
	p, _ = Read(ctx, o, o.DB, PageRequest{Schema: "main", Table: "people", Type: "table", Limit: 2, Offset: 2})
	if p.HasMore || len(p.Rows) != 2 || p.Rows[1][2] != nil {
		t.Fatalf("second page: %+v", p.Rows)
	}
	p, err = Read(ctx, o, o.DB, PageRequest{Schema: "main", Table: "people", Type: "table", Where: "age > 30", OrderBy: "age desc"})
	if err != nil || len(p.Rows) != 2 || p.Rows[0][1] != "Grace" {
		t.Fatalf("filter/sort: %+v %v", p, err)
	}
	if n, err := Count(ctx, o, o.DB, PageRequest{Schema: "main", Table: "people"}); err != nil || n != 4 {
		t.Fatalf("count all: %d %v", n, err)
	}
	if n, err := Count(ctx, o, o.DB, PageRequest{Schema: "main", Table: "people", Where: "age > 30"}); err != nil || n != 2 {
		t.Fatalf("count filter: %d %v", n, err)
	}

	if p, _ := Read(ctx, o, o.DB, PageRequest{Schema: "main", Table: "adults", Type: "view"}); p.Editable || p.ReadOnly == "" {
		t.Error("views must not be editable")
	}
	if p, _ := Read(ctx, o, o.DB, PageRequest{Schema: "main", Table: "nokey", Type: "table"}); p.Editable {
		t.Error("tables without a primary key must not be editable")
	}
}

func TestApply(t *testing.T) {
	file, o := seed(t)

	res, err := applyTx(t, o, ApplyRequest{Schema: "main", Table: "people", Changes: []Change{
		{Op: "update", Key: map[string]any{"id": float64(1)}, Values: map[string]any{"name": "Ada L.", "age": "37"}},
		{Op: "update", Key: map[string]any{"id": float64(4)}, Values: map[string]any{"age": nil}},
		{Op: "delete", Key: map[string]any{"id": float64(2)}},
		{Op: "insert", Values: map[string]any{"id": "5", "name": "Barbara", "age": float64(70)}},
	}})
	if err != nil || *res != (ApplyResult{Inserted: 1, Updated: 2, Deleted: 1}) {
		t.Fatalf("apply: %+v %v", res, err)
	}
	var name string
	var age int
	o.DB.QueryRow("select name, age from people where id = 1").Scan(&name, &age)
	if name != "Ada L." || age != 37 {
		t.Errorf("update not applied: %s %d", name, age)
	}

	// A change that matches no row rolls back the whole batch.
	_, err = applyTx(t, o, ApplyRequest{Schema: "main", Table: "people", Changes: []Change{
		{Op: "update", Key: map[string]any{"id": float64(3)}, Values: map[string]any{"name": "changed"}},
		{Op: "delete", Key: map[string]any{"id": float64(999)}},
	}})
	if err == nil || !strings.Contains(err.Error(), "matched 0 rows") {
		t.Fatalf("expected a conflict error, got %v", err)
	}
	o.DB.QueryRow("select name from people where id = 3").Scan(&name)
	if name != "Grace" {
		t.Errorf("batch was not rolled back: %s", name)
	}

	// Unknown and binary columns are refused.
	for _, ch := range []Change{
		{Op: "update", Key: map[string]any{"id": float64(1)}, Values: map[string]any{"nope": "x"}},
		{Op: "update", Key: map[string]any{"id": float64(1)}, Values: map[string]any{"photo": "0x00"}},
		{Op: "update", Key: map[string]any{}, Values: map[string]any{"name": "x"}},
	} {
		if _, err := applyTx(t, o, ApplyRequest{Schema: "main", Table: "people", Changes: []Change{ch}}); err == nil {
			t.Errorf("change %+v should be refused", ch)
		}
	}

	// Read-only connections refuse every change.
	ro := open(t, true, file)
	if _, err := applyTx(t, ro, ApplyRequest{Schema: "main", Table: "people", Changes: []Change{{Op: "delete", Key: map[string]any{"id": float64(1)}}}}); err == nil {
		t.Error("read-only connection accepted a change")
	}
}

func TestPostgresBind(t *testing.T) {
	b := builder{kind: driver.Postgres, d: mustDriver(t, driver.Postgres), target: `"public"."t"`,
		cols: map[string]Column{"id": {Name: "id", Type: "integer", PK: true, Editable: true}, "at": {Name: "at", Type: "timestamp with time zone", Editable: true}},
		pks:  []Column{{Name: "id", Type: "integer", PK: true, Editable: true}}}
	sql, args, err := b.build(Change{Op: "update", Key: map[string]any{"id": float64(7)}, Values: map[string]any{"at": "2024-03-01 10:00:00 +01:00"}})
	want := `UPDATE "public"."t" SET "at" = CAST($1 AS text)::timestamp with time zone WHERE "id" = CAST($2 AS text)::integer`
	if err != nil || sql != want || args[0] != "2024-03-01 10:00:00 +01:00" || args[1] != "7" {
		t.Fatalf("got %q %v %v", sql, args, err)
	}
}

func mustDriver(t *testing.T, k driver.Kind) driver.Driver {
	d, err := driver.Get(k)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// applyTx mirrors what the executor does in auto-commit mode.
func applyTx(t *testing.T, o *conn.Open, req ApplyRequest) (*ApplyResult, error) {
	t.Helper()
	ctx := context.Background()
	tx, err := o.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	res, err := Apply(ctx, o, tx, req)
	if err != nil {
		return nil, err
	}
	return res, tx.Commit()
}
