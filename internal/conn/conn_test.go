package conn

import (
	"context"
	"path/filepath"
	"testing"

	"dolmen/internal/driver"
)

func TestGetDB(t *testing.T) {
	ctx := context.Background()
	m := NewManager()
	defer m.CloseAll()

	if _, err := m.GetDB(ctx, "c", ""); err == nil {
		t.Fatal("GetDB on a closed connection should fail")
	}
	cfg := driver.Config{ID: "c", Name: "c", Kind: driver.SQLite, FilePath: filepath.Join(t.TempDir(), "x.db")}
	main, err := m.Connect(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if o, err := m.GetDB(ctx, "c", ""); err != nil || o != main {
		t.Fatalf("GetDB(\"\") = %v, %v; want the main pool", o, err)
	}
	// SQLite has no database level: another database name is an error, not a new pool.
	if _, err := m.GetDB(ctx, "c", "other"); err == nil {
		t.Fatal("GetDB(other) on SQLite should fail")
	}
	m.Disconnect("c")
	if _, err := m.Get("c"); err == nil {
		t.Fatal("still connected after Disconnect")
	}
}
