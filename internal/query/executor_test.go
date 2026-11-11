package query_test

import (
	"bytes"
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"dolmen/internal/conn"
	"dolmen/internal/driver"
	"dolmen/internal/export"
	"dolmen/internal/history"
	"dolmen/internal/query"
)

func setup(t *testing.T) (*query.Executor, *conn.Manager, *history.Store, string) {
	t.Helper()
	dir := t.TempDir()
	h, err := history.Open(filepath.Join(dir, "hist.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { h.Close() })
	m := conn.NewManager()
	t.Cleanup(m.CloseAll)
	return query.NewExecutor(m, h), m, h, filepath.Join(dir, "data.db")
}

func run(t *testing.T, e *query.Executor, tab, connID, sql string, cursor, max int) *query.ExecResponse {
	t.Helper()
	r, err := e.Execute(query.ExecRequest{TabID: tab, ConnID: connID, SQL: sql, Cursor: cursor, MaxRows: max})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestExecutorSQLite(t *testing.T) {
	e, m, h, file := setup(t)
	ctx := context.Background()
	rw := driver.Config{ID: "rw", Name: "rw", Kind: driver.SQLite, FilePath: file}
	if _, err := m.Connect(ctx, rw); err != nil {
		t.Fatal(err)
	}

	setupSQL := `create table t (id integer primary key, name text, b blob);
		with recursive n(i) as (select 1 union all select i + 1 from n where i < 25)
		insert into t (id, name) select i, 'row ' || i from n;
		select * from t order by id;`
	r := run(t, e, "tab1", "rw", setupSQL, -1, 10)
	if len(r.Results) != 3 {
		t.Fatalf("want 3 results, got %d: %+v", len(r.Results), r.Results)
	}
	if r.Results[1].RowsAffected != 25 {
		t.Errorf("insert affected %d", r.Results[1].RowsAffected)
	}
	sel := r.Results[2]
	if sel.Error != "" || len(sel.Rows) != 10 || !sel.HasMore || !sel.CanFetchMore {
		t.Fatalf("select: %+v", sel)
	}
	if sel.Columns[1].Name != "name" || sel.Rows[0][1] != "row 1" || sel.Rows[0][2] != nil {
		t.Errorf("unexpected first row %v / cols %v", sel.Rows[0], sel.Columns)
	}

	// Fetch the next page: rows 11..20, then the remaining 5.
	f, err := e.FetchMore("tab1", sel.ID, 10)
	if err != nil || len(f.Rows) != 10 || !f.HasMore || f.Rows[0][0] != int64(11) {
		t.Fatalf("fetch more: %+v %v", f, err)
	}

	// Export drains the cursor: 20 cached + 5 remaining rows.
	var buf bytes.Buffer
	n, err := export.Write(&buf, export.CSV, func(hdr func([]query.Column) error, row func([]any) error) error {
		return e.Rows("tab1", sel.ID, hdr, row)
	})
	if err != nil || n != 25 {
		t.Fatalf("export: n=%d err=%v", n, err)
	}
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if lines[0] != "id,name,b" || lines[25] != "25,row 25," {
		t.Errorf("csv head %q tail %q", lines[0], lines[len(lines)-1])
	}
	if _, err := e.FetchMore("tab1", sel.ID, 10); err == nil {
		t.Error("cursor should be closed after export")
	}

	// Cursor picks the statement under the caret (UTF-16 offset).
	two := "select 1 as a;\nselect 'é😀', 2 as b;"
	r = run(t, e, "tab1", "rw", two, len([]rune(two))+1, 0)
	if len(r.Results) != 1 || r.Results[0].Columns[1].Name != "b" {
		t.Fatalf("cursor statement: %+v", r.Results)
	}

	// Errors stop the script.
	r = run(t, e, "tab1", "rw", "select 1; select * from missing; select 3", -1, 0)
	if len(r.Results) != 2 || r.Results[1].Error == "" {
		t.Fatalf("stop on error: %+v", r.Results)
	}

	// Session state persists across runs within a tab.
	run(t, e, "tab2", "rw", "create temp table tmp_x (a int)", -1, 0)
	if r = run(t, e, "tab2", "rw", "select count(*) from tmp_x", -1, 0); r.Results[0].Error != "" {
		t.Fatalf("temp table should survive in the tab session: %v", r.Results[0].Error)
	}

	// History recorded.
	hs, err := h.List(ctx, "rw", "missing", 10)
	if err != nil || len(hs) != 1 || hs[0].Status != "error" {
		t.Fatalf("history: %+v %v", hs, err)
	}

	// Read-only connection: guard rejects, and the session-level mode=ro blocks writes the guard allows through.
	ro := driver.Config{ID: "ro", Name: "ro", Kind: driver.SQLite, FilePath: file, ReadOnly: true}
	if _, err := m.Connect(ctx, ro); err != nil {
		t.Fatal(err)
	}
	r = run(t, e, "tab3", "ro", "select count(*) from t; delete from t", -1, 0)
	if len(r.Results) != 1 || !strings.Contains(r.Results[0].Error, "read-only") {
		t.Fatalf("guard: %+v", r.Results)
	}
	r = run(t, e, "tab3", "ro", "with x as (select 1) select * from x", -1, 0)
	if r.Results[0].Error != "" {
		t.Fatalf("read query on ro: %v", r.Results[0].Error)
	}
}

func TestExecutorCancel(t *testing.T) {
	e, m, _, file := setup(t)
	if _, err := m.Connect(context.Background(), driver.Config{ID: "c", Name: "c", Kind: driver.SQLite, FilePath: file}); err != nil {
		t.Fatal(err)
	}
	go func() {
		time.Sleep(200 * time.Millisecond)
		e.Cancel("tab")
	}()
	slow := "with recursive n(i) as (select 1 union all select i + 1 from n) select count(*) from n"
	r := run(t, e, "tab", "c", slow, -1, 0)
	if !r.Cancelled {
		t.Fatalf("expected cancellation: %+v", r)
	}
	// The tab recovers with a fresh session.
	if r = run(t, e, "tab", "c", "select 1", -1, 0); r.Results[0].Error != "" {
		t.Fatal(r.Results[0].Error)
	}
}

func TestNormalize(t *testing.T) {
	cases := map[string]struct{ in, want any }{
		"bytes text":   {[]byte("hi"), "hi"},
		"bytes binary": {[]byte{0xff, 0x00}, "0xff00"},
		"big int":      {int64(1) << 60, "1152921504606846976"},
		"small int":    {int64(42), int64(42)},
		"date":         {time.Date(2024, 3, 1, 0, 0, 0, 0, time.UTC), "2024-03-01"},
		"timestamp":    {time.Date(2024, 3, 1, 10, 30, 0, 500, time.UTC), "2024-03-01 10:30:00.0000005"},
	}
	for name, c := range cases {
		if got := query.Normalize(c.in); got != c.want {
			t.Errorf("%s: got %#v want %#v", name, got, c.want)
		}
	}
}
