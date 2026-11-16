package mcp

import (
	"strings"
	"testing"

	"dolmen/internal/driver"
)

func TestNormalize(t *testing.T) {
	got := Config{
		Port:      0,
		Write:     true,
		Databases: []string{" sales ", "", "SALES", "analytics"},
		Schemas:   []string{"public", " public ", "reports"},
	}.Normalize()
	if got.Port != DefaultPort {
		t.Errorf("port = %d, want %d", got.Port, DefaultPort)
	}
	if !got.Read {
		t.Error("write access did not imply read access")
	}
	if strings.Join(got.Databases, ",") != "sales,analytics" {
		t.Errorf("databases = %v", got.Databases)
	}
	if strings.Join(got.Schemas, ",") != "public,reports" {
		t.Errorf("schemas = %v", got.Schemas)
	}
}

func TestValidate(t *testing.T) {
	cases := []struct {
		name string
		cfg  Config
		ok   bool
	}{
		{"disabled defaults", DefaultConfig(), true},
		{"enabled read-only", Config{Enabled: true, Port: 8770, Token: "t", Read: true}, true},
		{"no access", Config{Enabled: true, Port: 8770, Token: "t"}, false},
		{"no token", Config{Enabled: true, Port: 8770, Read: true}, false},
		{"port too low", Config{Enabled: true, Port: -1, Token: "t", Read: true}, false},
		{"port too high", Config{Enabled: true, Port: 70000, Token: "t", Read: true}, false},
	}
	for _, c := range cases {
		err := c.cfg.Validate()
		if (err == nil) != c.ok {
			t.Errorf("%s: Validate() = %v, ok = %v", c.name, err, c.ok)
		}
	}
}

func TestPermissionChecks(t *testing.T) {
	all := DefaultConfig()
	if !all.AllowsRead() || all.AllowsWrite() {
		t.Fatalf("defaults: read=%v write=%v", all.AllowsRead(), all.AllowsWrite())
	}
	if !all.AllowsDatabase(driver.Postgres, "anything") || !all.AllowsSchema("anything") {
		t.Fatal("empty allow-lists should allow everything")
	}

	c := Config{Read: true, Databases: []string{"sales"}, Schemas: []string{"public"}}.Normalize()
	if !c.AllowsDatabase(driver.Postgres, "SALES") {
		t.Error("database matching is case-insensitive")
	}
	if c.AllowsDatabase(driver.Postgres, "analytics") {
		t.Error("a database outside the allow-list was accepted")
	}
	if !c.AllowsSchema("PUBLIC") || c.AllowsSchema("private") {
		t.Error("schema allow-list not enforced")
	}

	// MySQL has no database level above schemas: the schema list must also
	// restrict the database a tool can open.
	mysql := Config{Read: true, Schemas: []string{"shop"}}.Normalize()
	if mysql.AllowsDatabase(driver.MySQL, "other") {
		t.Error("MySQL schema allow-list did not restrict its databases")
	}
	if !mysql.AllowsDatabase(driver.MySQL, "shop") {
		t.Error("allowed MySQL schema was rejected")
	}
}

func TestDescribePermissions(t *testing.T) {
	c := Config{Read: true, Write: true, Databases: []string{"sales"}}.Normalize()
	text := c.DescribePermissions()
	for _, want := range []string{"read data", "write data", "allowed in Dolmen"} {
		if !strings.Contains(text, want) {
			t.Errorf("instructions %q do not mention %q", text, want)
		}
	}
}
