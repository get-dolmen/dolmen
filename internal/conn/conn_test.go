package conn

import (
	"context"
	"path/filepath"
	"testing"

	"dolmen/internal/driver"
	"dolmen/internal/sshtunnel"
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

func TestValidateSSH(t *testing.T) {
	base := driver.Config{
		Name: "db", Kind: driver.Postgres, Host: "db.internal",
		SSH: &sshtunnel.Config{Enabled: true, Host: "bastion", User: "deploy", Method: "password", Password: "x"},
	}
	if err := validate(base); err != nil {
		t.Fatalf("valid tunnel rejected: %v", err)
	}

	cases := []struct {
		name string
		edit func(*driver.Config)
	}{
		{"sqlite", func(c *driver.Config) { c.Kind = driver.SQLite; c.FilePath = "x.db" }},
		{"no host", func(c *driver.Config) { c.SSH.Host = "  " }},
		{"no user", func(c *driver.Config) { c.SSH.User = "" }},
		{"no password", func(c *driver.Config) { c.SSH.Password = "" }},
		{"key without path", func(c *driver.Config) { c.SSH.Method = "key" }},
		{"unknown method", func(c *driver.Config) { c.SSH.Method = "kerberos" }},
	}
	for _, tc := range cases {
		cfg := base
		ssh := *base.SSH
		cfg.SSH = &ssh
		tc.edit(&cfg)
		if err := validate(cfg); err == nil {
			t.Errorf("%s: invalid tunnel accepted", tc.name)
		}
	}

	agent := base
	agentSSH := *base.SSH
	agentSSH.Method, agentSSH.Password = "agent", ""
	agent.SSH = &agentSSH
	if err := validate(agent); err != nil {
		t.Errorf("agent tunnel rejected: %v", err)
	}

	off := base
	offSSH := *base.SSH
	offSSH.Enabled = false
	off.SSH = &offSSH
	off.SSH.Host, off.SSH.User, off.SSH.Password = "", "", ""
	if err := validate(off); err != nil {
		t.Errorf("disabled tunnel rejected: %v", err)
	}
}
