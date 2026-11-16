package mcp

import (
	"os"
	"strings"
	"testing"
)

func TestStoreCreatesDefaultsAndToken(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(store.Path())
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode = %o, want 600", info.Mode().Perm())
	}
	cfg, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Enabled || !cfg.Read || cfg.Write || cfg.Port != DefaultPort {
		t.Fatalf("defaults = %+v", cfg)
	}
	if len(cfg.Token) < 32 {
		t.Fatalf("token = %q, want a long random value", cfg.Token)
	}

	// A second store reads the same token rather than generating a new one.
	again, err := NewStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	reloaded, err := again.Load()
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.Token != cfg.Token {
		t.Fatal("the access token was regenerated on reload")
	}
}

func TestStoreRoundTrip(t *testing.T) {
	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cfg := Config{
		Enabled: true, Port: 9100, Read: true, Write: true,
		Databases: []string{" sales ", "sales", "analytics"},
		Schemas:   []string{"public"},
	}
	if err := store.Save(cfg); err != nil {
		t.Fatal(err)
	}
	got, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if !got.Enabled || got.Port != 9100 || !got.Write {
		t.Fatalf("round-trip = %+v", got)
	}
	if strings.Join(got.Databases, ",") != "sales,analytics" {
		t.Fatalf("databases = %v", got.Databases)
	}
	if got.Token == "" {
		t.Fatal("save did not generate a token")
	}
}

func TestNewTokenIsUnique(t *testing.T) {
	a, err := NewToken()
	if err != nil {
		t.Fatal(err)
	}
	b, err := NewToken()
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Fatal("two tokens are identical")
	}
	if strings.ContainsAny(a, "+/=") {
		t.Fatalf("token %q is not URL-safe", a)
	}
}
