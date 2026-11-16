// Package mcp exposes Dolmen's saved connections to MCP clients through a
// local HTTP endpoint, inside a permission policy set in the settings dialog.
package mcp

import (
	"errors"
	"fmt"
	"strings"

	"dolmen/internal/driver"
)

// DefaultPort is where the MCP endpoint listens unless the user picks another.
const DefaultPort = 8770

// Config is the MCP server's settings and permission policy.
//
// Databases and Schemas are allow-lists: an empty list means every database
// or schema. Write implies Read, because a client that may change data also
// needs to see the tables it is changing. Token is the bearer token clients
// must send; it is generated on first use.
type Config struct {
	Enabled   bool     `json:"enabled"`
	Port      int      `json:"port"`
	Token     string   `json:"token"`
	Read      bool     `json:"read"`
	Write     bool     `json:"write"`
	Databases []string `json:"databases"`
	Schemas   []string `json:"schemas"`
}

// DefaultConfig is the safe starting point: disabled, read-only, every
// database and schema reachable once read access is granted.
func DefaultConfig() Config {
	return Config{Port: DefaultPort, Read: true, Databases: []string{}, Schemas: []string{}}
}

// Normalize applies the defaults and tidies the allow-lists: names are
// trimmed, blank entries dropped and duplicates (case-insensitively) removed.
func (c Config) Normalize() Config {
	if c.Port == 0 {
		c.Port = DefaultPort
	}
	if c.Write {
		c.Read = true
	}
	c.Databases = cleanNames(c.Databases)
	c.Schemas = cleanNames(c.Schemas)
	return c
}

// Validate rejects settings that would leave the server with nothing to do.
func (c Config) Validate() error {
	c = c.Normalize()
	if c.Port < 1 || c.Port > 65535 {
		return fmt.Errorf("port %d is out of range", c.Port)
	}
	if c.Enabled && !c.Read && !c.Write {
		return errors.New("enable read or write access before starting the MCP server")
	}
	if c.Enabled && strings.TrimSpace(c.Token) == "" {
		return errors.New("an access token is required")
	}
	return nil
}

// AllowsRead reports whether clients may browse and query data.
func (c Config) AllowsRead() bool { return c.Normalize().Read }

// AllowsWrite reports whether clients may run statements that change data.
func (c Config) AllowsWrite() bool { return c.Normalize().Write }

// AllowsDatabase reports whether a client may open a database. For MySQL a
// schema and a database are the same level, so a schema allow-list also
// narrows the databases that can be opened.
func (c Config) AllowsDatabase(kind driver.Kind, database string) bool {
	c = c.Normalize()
	if database != "" && len(c.Databases) > 0 && !containsName(c.Databases, database) {
		return false
	}
	if database != "" && kind == driver.MySQL && len(c.Schemas) > 0 && !containsName(c.Schemas, database) {
		return false
	}
	return true
}

// AllowsSchema reports whether a client may read a schema's metadata or use
// it in a qualified name. An empty name (the connection's default) is allowed;
// the caller resolves it first.
func (c Config) AllowsSchema(schema string) bool {
	c = c.Normalize()
	if schema == "" || len(c.Schemas) == 0 {
		return true
	}
	return containsName(c.Schemas, schema)
}

// DescribePermissions is the instruction text MCP clients receive when they
// initialize a session.
func (c Config) DescribePermissions() string {
	c = c.Normalize()
	var access []string
	if c.Read {
		access = append(access, "read data")
	}
	if c.Write {
		access = append(access, "write data")
	}
	if len(access) == 0 {
		access = append(access, "nothing")
	}
	scope := "every database and schema"
	if len(c.Databases) > 0 || len(c.Schemas) > 0 {
		scope = "only the databases and schemas allowed in Dolmen's MCP settings"
	}
	return fmt.Sprintf(
		"Dolmen is a desktop SQL client for PostgreSQL, MySQL, Oracle and SQLite. "+
			"This server lets MCP clients %s, in %s. "+
			"Use list_connections to find saved connections, then list_databases, list_schemas, list_tables and describe_table to explore them. "+
			"read_query only accepts read-only statements; write_query is available only when write access is granted.",
		strings.Join(access, " and "), scope)
}

func cleanNames(in []string) []string {
	out := make([]string, 0, len(in))
	for _, raw := range in {
		name := strings.TrimSpace(raw)
		if name == "" {
			continue
		}
		if containsName(out, name) {
			continue
		}
		out = append(out, name)
	}
	return out
}

func containsName(list []string, name string) bool {
	for _, candidate := range list {
		if strings.EqualFold(candidate, name) {
			return true
		}
	}
	return false
}
