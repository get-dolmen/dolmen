// Package scratch persists scratch files and the editor workspace.
//
// A scratch file is a .sql file linked to a connection (and, for Postgres, a
// database). Scratch files live independently of tabs: closing a tab keeps its
// file; only an explicit delete removes it. On disk:
//
//	<dir>/<id>.sql      content of each scratch
//	<dir>/index.json    metadata of every scratch (name, link, timestamps)
//	<dir>/tabs.json     the open tabs, their order and the active one
package scratch

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Tab is an open editor tab. SQL tabs share their ID with a scratch file.
type Tab struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	ConnID string `json:"connId"`
	// Database is another database of the connection's server (Postgres); "" = the connection's own.
	Database string `json:"database,omitempty"`
	// Kind is "sql" (scratch file, the default) or "table" (data editor for Schema.Table).
	Kind      string `json:"kind,omitempty"`
	Schema    string `json:"schema,omitempty"`
	Table     string `json:"table,omitempty"`
	TableType string `json:"tableType,omitempty"`
	// TxMode is "manual" when the tab keeps transactions open; "" = auto-commit.
	TxMode  string `json:"txMode,omitempty"`
	Content string `json:"content,omitempty"` // not stored in the manifest
}

type Workspace struct {
	Tabs     []Tab  `json:"tabs"`
	ActiveID string `json:"activeId"`
}

// Info describes a scratch file for the scratch list.
type Info struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	ConnID    string `json:"connId"`
	Database  string `json:"database,omitempty"`
	Schema    string `json:"schema,omitempty"` // table the scratch is filed under (optional)
	Table     string `json:"table,omitempty"`
	CreatedAt int64  `json:"createdAt"` // unix ms
	UpdatedAt int64  `json:"updatedAt"` // unix ms
	Size      int    `json:"size"`
	Preview   string `json:"preview,omitempty"` // first meaningful line
}

type meta struct {
	Name      string `json:"name"`
	ConnID    string `json:"connId"`
	Database  string `json:"database,omitempty"`
	Schema    string `json:"schema,omitempty"`
	Table     string `json:"table,omitempty"`
	CreatedAt int64  `json:"createdAt"`
	UpdatedAt int64  `json:"updatedAt"`
}

type Store struct {
	dir   string
	mu    sync.Mutex
	index map[string]*meta
}

var validID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func NewStore(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s := &Store{dir: dir}
	if err := s.loadIndex(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) manifestPath() string { return filepath.Join(s.dir, "tabs.json") }
func (s *Store) indexPath() string    { return filepath.Join(s.dir, "index.json") }

func (s *Store) filePath(id string) (string, error) {
	if !validID.MatchString(id) {
		return "", fmt.Errorf("invalid scratch id %q", id)
	}
	return filepath.Join(s.dir, id+".sql"), nil
}

func now() int64 { return time.Now().UnixMilli() }

// loadIndex reads index.json, and adopts .sql files it does not know about
// (e.g. scratches created before the index existed) using the open-tab
// manifest for their names and links.
func (s *Store) loadIndex() error {
	s.index = map[string]*meta{}
	if b, err := os.ReadFile(s.indexPath()); err == nil {
		json.Unmarshal(b, &s.index)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	var ws Workspace
	if b, err := os.ReadFile(s.manifestPath()); err == nil {
		json.Unmarshal(b, &ws)
	}
	tabs := map[string]Tab{}
	for _, t := range ws.Tabs {
		tabs[t.ID] = t
	}
	files, _ := filepath.Glob(filepath.Join(s.dir, "*.sql"))
	changed := false
	for _, f := range files {
		id := strings.TrimSuffix(filepath.Base(f), ".sql")
		if !validID.MatchString(id) || s.index[id] != nil {
			continue
		}
		st, err := os.Stat(f)
		if err != nil {
			continue
		}
		m := &meta{Name: id + ".sql", CreatedAt: st.ModTime().UnixMilli(), UpdatedAt: st.ModTime().UnixMilli()}
		if t, ok := tabs[id]; ok {
			m.Name, m.ConnID, m.Database = t.Name, t.ConnID, t.Database
		}
		s.index[id] = m
		changed = true
	}
	// Forget entries whose file disappeared.
	for id := range s.index {
		if p, _ := s.filePath(id); p == "" || !exists(p) {
			delete(s.index, id)
			changed = true
		}
	}
	if changed {
		return s.writeIndex()
	}
	return nil
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func (s *Store) writeIndex() error {
	b, err := json.MarshalIndent(s.index, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(s.indexPath(), b)
}

// Load returns the open tabs; SQL tabs carry their scratch's content and link.
func (s *Store) Load() (Workspace, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ws := Workspace{Tabs: []Tab{}}
	b, err := os.ReadFile(s.manifestPath())
	if errors.Is(err, os.ErrNotExist) {
		return ws, nil
	}
	if err != nil {
		return ws, err
	}
	if err := json.Unmarshal(b, &ws); err != nil {
		return Workspace{Tabs: []Tab{}}, nil // corrupt manifest: start fresh
	}
	out := ws.Tabs[:0]
	for _, t := range ws.Tabs {
		if t.Kind != "table" {
			m := s.index[t.ID]
			if m == nil {
				continue // its scratch was deleted
			}
			t.Name, t.ConnID, t.Database = m.Name, m.ConnID, m.Database
			if p, err := s.filePath(t.ID); err == nil {
				c, _ := os.ReadFile(p)
				t.Content = string(c)
			}
		}
		out = append(out, t)
	}
	ws.Tabs = out
	return ws, nil
}

// SaveLayout writes the open tabs and keeps the scratch index in sync with
// the names and links of open SQL tabs.
func (s *Store) SaveLayout(ws Workspace) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := Workspace{ActiveID: ws.ActiveID, Tabs: make([]Tab, 0, len(ws.Tabs))}
	changed := false
	for _, t := range ws.Tabs {
		p, err := s.filePath(t.ID)
		if err != nil {
			return err
		}
		t.Content = ""
		if t.Kind != "table" {
			m := s.index[t.ID]
			if m == nil {
				m = &meta{CreatedAt: now(), UpdatedAt: now()}
				s.index[t.ID] = m
				if !exists(p) {
					atomicWrite(p, nil)
				}
			}
			if m.ConnID != t.ConnID || m.Database != t.Database {
				// Moved to another connection or database: the table link no longer applies.
				m.Schema, m.Table = "", ""
			}
			if m.Name != t.Name || m.ConnID != t.ConnID || m.Database != t.Database {
				m.Name, m.ConnID, m.Database = t.Name, t.ConnID, t.Database
				changed = true
			}
			changed = changed || m.CreatedAt == 0
		}
		out.Tabs = append(out.Tabs, t)
	}
	if changed {
		if err := s.writeIndex(); err != nil {
			return err
		}
	}
	b, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(s.manifestPath(), b)
}

// SaveContent writes a scratch's content.
func (s *Store) SaveContent(id, content string) error {
	p, err := s.filePath(id)
	if err != nil {
		return err
	}
	if err := atomicWrite(p, []byte(content)); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.index[id]
	if m == nil {
		m = &meta{Name: id + ".sql", CreatedAt: now()}
		s.index[id] = m
	}
	m.UpdatedAt = now()
	return s.writeIndex()
}

// List returns every scratch, most recently edited first.
func (s *Store) List() []Info {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Info, 0, len(s.index))
	for id, m := range s.index {
		info := Info{ID: id, Name: m.Name, ConnID: m.ConnID, Database: m.Database, Schema: m.Schema, Table: m.Table, CreatedAt: m.CreatedAt, UpdatedAt: m.UpdatedAt}
		if p, err := s.filePath(id); err == nil {
			if b, err := os.ReadFile(p); err == nil {
				info.Size = len(b)
				info.Preview = preview(string(b))
			}
		}
		out = append(out, info)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt > out[j].UpdatedAt })
	return out
}

// preview returns the first line that is not blank or a comment marker only.
func preview(s string) string {
	for line := range strings.SplitSeq(s, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || line == "--" || line == "/*" {
			continue
		}
		if utf8.RuneCountInString(line) > 120 {
			line = string([]rune(line)[:120]) + "…"
		}
		return line
	}
	return ""
}

// Get returns a scratch as a tab ready to open.
func (s *Store) Get(id string) (Tab, error) {
	p, err := s.filePath(id)
	if err != nil {
		return Tab{}, err
	}
	s.mu.Lock()
	m := s.index[id]
	s.mu.Unlock()
	if m == nil {
		return Tab{}, fmt.Errorf("scratch %s not found", id)
	}
	b, err := os.ReadFile(p)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return Tab{}, err
	}
	return Tab{ID: id, Name: m.Name, ConnID: m.ConnID, Database: m.Database, Kind: "sql", Content: string(b)}, nil
}

// Create adds a scratch file and returns it. Schema and table optionally file
// it under a table.
func (s *Store) Create(id, name, connID, database, schema, table, content string) (Tab, error) {
	p, err := s.filePath(id)
	if err != nil {
		return Tab{}, err
	}
	name, err = CleanName(name)
	if err != nil {
		return Tab{}, err
	}
	if err := atomicWrite(p, []byte(content)); err != nil {
		return Tab{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.index[id] = &meta{Name: name, ConnID: connID, Database: database, Schema: schema, Table: table, CreatedAt: now(), UpdatedAt: now()}
	return Tab{ID: id, Name: name, ConnID: connID, Database: database, Kind: "sql", Content: content}, s.writeIndex()
}

// Link files a scratch under a connection, database and optionally a table.
func (s *Store) Link(id, connID, database, schema, table string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.index[id]
	if m == nil {
		return fmt.Errorf("scratch %s not found", id)
	}
	if table == "" {
		schema = ""
	}
	m.ConnID, m.Database, m.Schema, m.Table = connID, database, schema, table
	return s.writeIndex()
}

// Rename changes a scratch's display name.
func (s *Store) Rename(id, name string) (string, error) {
	name, err := CleanName(name)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.index[id]
	if m == nil {
		return "", fmt.Errorf("scratch %s not found", id)
	}
	m.Name = name
	return name, s.writeIndex()
}

// CleanName validates a scratch name and gives it a .sql extension when it has none.
func CleanName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", errors.New("a name is required")
	}
	if strings.ContainsAny(name, `/\`) {
		return "", errors.New("a name cannot contain / or \\")
	}
	if filepath.Ext(name) == "" {
		name += ".sql"
	}
	return name, nil
}

// Delete removes a scratch file and its metadata.
func (s *Store) Delete(id string) error {
	p, err := s.filePath(id)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.index, id)
	return s.writeIndex()
}

// IsBlank reports whether a scratch is empty (only whitespace).
func (s *Store) IsBlank(id string) bool {
	p, err := s.filePath(id)
	if err != nil {
		return false
	}
	b, err := os.ReadFile(p)
	return err != nil || strings.TrimSpace(string(b)) == ""
}

func atomicWrite(path string, b []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
