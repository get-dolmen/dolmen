package driver

import (
	"strings"
	"testing"
)

func TestDefaultPort(t *testing.T) {
	cases := map[Kind]int{
		Postgres: 5432,
		MySQL:    3306,
		Oracle:   1521,
		SQLite:   0,
	}
	for kind, want := range cases {
		if got := DefaultPort(kind); got != want {
			t.Errorf("DefaultPort(%s) = %d, want %d", kind, got, want)
		}
	}
}

func TestOracleDSN(t *testing.T) {
	dsn, err := oracle{}.DSN(Config{
		Host:     "db.example.com",
		Database: "ORCL",
		User:     "scott",
		Password: "tiger",
		Options: map[string]string{
			"SID":           "ORCL",
			"DBA PRIVILEGE": "SYSDBA",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"oracle://scott:tiger@db.example.com:1521/ORCL",
		"SID=ORCL",
		"DBA PRIVILEGE=SYSDBA",
	} {
		if !strings.Contains(dsn, want) {
			t.Errorf("DSN %q does not contain %q", dsn, want)
		}
	}
}

func TestOracleDSNPrefersExplicitPort(t *testing.T) {
	dsn, err := oracle{}.DSN(Config{Host: "db", Port: 1522, Database: "FREEPDB1", User: "u"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(dsn, ":1522/") {
		t.Errorf("DSN %q does not use port 1522", dsn)
	}
}
