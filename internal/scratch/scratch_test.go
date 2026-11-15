package scratch

import (
	"os"
	"path/filepath"
	"testing"
)

func TestScratchLifecycle(t *testing.T) {
	dir := t.TempDir()
	s, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}

	// A tab saved through the layout becomes a scratch with its link.
	if err := s.SaveLayout(Workspace{ActiveID: "a", Tabs: []Tab{{ID: "a", Name: "orders.sql", ConnID: "c1", Database: "blog"}}}); err != nil {
		t.Fatal(err)
	}
	if err := s.SaveContent("a", "\n-- revenue\nselect 1;\n"); err != nil {
		t.Fatal(err)
	}
	list := s.List()
	if len(list) != 1 || list[0].Name != "orders.sql" || list[0].ConnID != "c1" || list[0].Database != "blog" || list[0].Preview != "-- revenue" {
		t.Fatalf("list: %+v", list)
	}

	// Closing the tab (layout without it) keeps the scratch.
	s.SaveLayout(Workspace{Tabs: []Tab{}})
	if got, err := s.Get("a"); err != nil || got.Content != "\n-- revenue\nselect 1;\n" || got.Database != "blog" {
		t.Fatalf("get after close: %+v %v", got, err)
	}

	// Rename adds .sql when there is no extension; invalid names are refused.
	if name, err := s.Rename("a", " revenue "); err != nil || name != "revenue.sql" {
		t.Fatalf("rename: %q %v", name, err)
	}
	if _, err := s.Rename("a", "a/b"); err == nil {
		t.Fatal("slash in name should be refused")
	}

	// Reopening restores name and link from the index, even if the tab manifest is stale.
	s.SaveLayout(Workspace{ActiveID: "a", Tabs: []Tab{{ID: "a", Name: "revenue.sql", ConnID: "c1", Database: "blog"}, {ID: "t", Kind: "table", Name: "users", Table: "users"}}})
	ws, _ := s.Load()
	if len(ws.Tabs) != 2 || ws.Tabs[0].Name != "revenue.sql" || ws.Tabs[1].Kind != "table" {
		t.Fatalf("load: %+v", ws.Tabs)
	}

	// Create, blank detection, delete.
	if _, err := s.Create("b", "empty", "c1", "", "", "", "   \n"); err != nil {
		t.Fatal(err)
	}
	if !s.IsBlank("b") || s.IsBlank("a") {
		t.Fatal("IsBlank")
	}
	if err := s.Delete("b"); err != nil || len(s.List()) != 1 {
		t.Fatalf("delete: %v %d", err, len(s.List()))
	}
	// A deleted scratch disappears from the open tabs too.
	s.Delete("a")
	if ws, _ := s.Load(); len(ws.Tabs) != 1 || ws.Tabs[0].Kind != "table" {
		t.Fatalf("deleted scratch still open: %+v", ws.Tabs)
	}
	if _, err := s.Get("../x"); err == nil {
		t.Fatal("path traversal should be refused")
	}
}

func TestAdoptsLegacyFiles(t *testing.T) {
	dir := t.TempDir()
	// Before the index existed: tabs.json + .sql files only.
	os.WriteFile(filepath.Join(dir, "old.sql"), []byte("select 2"), 0o600)
	os.WriteFile(filepath.Join(dir, "orphan.sql"), []byte("select 3"), 0o600)
	os.WriteFile(filepath.Join(dir, "tabs.json"), []byte(`{"tabs":[{"id":"old","name":"legacy.sql","connId":"c9"}],"activeId":"old"}`), 0o600)
	s, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]Info{}
	for _, i := range s.List() {
		byID[i.ID] = i
	}
	if byID["old"].Name != "legacy.sql" || byID["old"].ConnID != "c9" || byID["orphan"].Name != "orphan.sql" {
		t.Fatalf("adopted: %+v", byID)
	}
}

func TestTableLink(t *testing.T) {
	s, _ := NewStore(t.TempDir())
	if _, err := s.Create("a", "users.sql", "c1", "db1", "public", "users", "select 1"); err != nil {
		t.Fatal(err)
	}
	if i := s.List()[0]; i.Schema != "public" || i.Table != "users" {
		t.Fatalf("created link: %+v", i)
	}
	// New scratches start locked: unlock this one to test link changes.
	if err := s.SetLock("a", false); err != nil {
		t.Fatal(err)
	}
	// Re-saving the open tab with the same connection keeps the table link.
	s.SaveLayout(Workspace{Tabs: []Tab{{ID: "a", Name: "users.sql", ConnID: "c1", Database: "db1"}}})
	if i := s.List()[0]; i.Table != "users" {
		t.Fatalf("link lost on layout save: %+v", i)
	}
	// Switching the tab to another database drops it.
	s.SaveLayout(Workspace{Tabs: []Tab{{ID: "a", Name: "users.sql", ConnID: "c1", Database: "db2"}}})
	if i := s.List()[0]; i.Table != "" || i.Database != "db2" {
		t.Fatalf("link should be dropped: %+v", i)
	}
	// Link moves it explicitly; no table clears the schema too.
	s.Link("a", "c2", "", "main", "orders")
	if i := s.List()[0]; i.ConnID != "c2" || i.Table != "orders" || i.Schema != "main" {
		t.Fatalf("link: %+v", i)
	}
	s.Link("a", "c2", "", "main", "")
	if i := s.List()[0]; i.Table != "" || i.Schema != "" {
		t.Fatalf("unlink: %+v", i)
	}
}

func TestLockPinsLink(t *testing.T) {
	s, _ := NewStore(t.TempDir())
	if _, err := s.Create("a", "a.sql", "c1", "db1", "", "", "select 1"); err != nil {
		t.Fatal(err)
	}
	// A new scratch is locked to the link it was created with.
	if i := s.List()[0]; !i.Locked {
		t.Fatalf("new scratch is not locked: %+v", i)
	}
	if err := s.Link("a", "c2", "db2", "", ""); err == nil {
		t.Fatal("locked scratch accepted a new link")
	}
	// A layout save cannot move it either: the index owns the link.
	if err := s.SaveLayout(Workspace{Tabs: []Tab{{ID: "a", Name: "a.sql", ConnID: "c9", Database: "db9"}}}); err != nil {
		t.Fatal(err)
	}
	if i := s.List()[0]; i.ConnID != "c1" || i.Database != "db1" {
		t.Fatalf("locked link changed: %+v", i)
	}
	if ws, _ := s.Load(); len(ws.Tabs) != 1 || ws.Tabs[0].ConnID != "c1" || !ws.Tabs[0].Locked {
		t.Fatalf("loaded lock: %+v", ws.Tabs)
	}
	// A sync replacement keeps the local lock.
	if err := s.Replace([]Entry{{ID: "a", Name: "a.sql", ConnID: "c1", Database: "db1"}}); err != nil {
		t.Fatal(err)
	}
	if i := s.List()[0]; !i.Locked {
		t.Fatal("Replace dropped the lock")
	}
	// Unlocking lets it move again.
	if err := s.SetLock("a", false); err != nil {
		t.Fatal(err)
	}
	if err := s.Link("a", "c2", "db2", "", ""); err != nil {
		t.Fatal(err)
	}
	if i := s.List()[0]; i.ConnID != "c2" || i.Database != "db2" || i.Locked {
		t.Fatalf("unlocked link: %+v", i)
	}
}
