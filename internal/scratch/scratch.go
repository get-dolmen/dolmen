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

	"dolmen/internal/atomicfile"
	"dolmen/internal/jsonfile"
)

// Tab is an open editor tab. SQL tabs share their ID with a scratch file.
type Tab struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	ConnID string `json:"connId"`
	// Database is another database of the connection's server (Postgres); "" = the connection's own.
	Database string `json:"database,omitempty"`
	// Kind is "sql" (scratch file, the default), "table" (data editor for
	// Schema.Table) or "diagram" (the schema's table and foreign-key overview).
	Kind      string `json:"kind,omitempty"`
	Schema    string `json:"schema,omitempty"`
	Table     string `json:"table,omitempty"`
	TableType string `json:"tableType,omitempty"`
	// TxMode is "manual" when the tab keeps transactions open; "" = auto-commit.
	TxMode string `json:"txMode,omitempty"`
	// Locked pins the scratch to its connection, database and folder, so it
	// cannot be moved or retargeted by accident. New scratches start locked.
	Locked  bool   `json:"locked,omitempty"`
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
	Locked    bool   `json:"locked,omitempty"`
	CreatedAt int64  `json:"createdAt"` // unix ms
	UpdatedAt int64  `json:"updatedAt"` // unix ms
	Size      int    `json:"size"`
	Preview   string `json:"preview,omitempty"` // first meaningful line
}

type metadata struct {
	Name      string `json:"name"`
	ConnID    string `json:"connId"`
	Database  string `json:"database,omitempty"`
	Schema    string `json:"schema,omitempty"`
	Table     string `json:"table,omitempty"`
	Locked    bool   `json:"locked,omitempty"`
	CreatedAt int64  `json:"createdAt"`
	UpdatedAt int64  `json:"updatedAt"`
}

// Entry is one scratch file with its content, as exchanged by git sync.
type Entry struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	ConnID    string `json:"connId"`
	Database  string `json:"database,omitempty"`
	Schema    string `json:"schema,omitempty"`
	Table     string `json:"table,omitempty"`
	CreatedAt int64  `json:"createdAt"`
	UpdatedAt int64  `json:"updatedAt"`
	Content   string `json:"content"`
}

type Store struct {
	dir   string
	mu    sync.Mutex
	index map[string]*metadata
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
// (for example, scratches created before the index existed) using the open-tab
// manifest for their names and links.
func (s *Store) loadIndex() error {
	s.index = map[string]*metadata{}
	if data, err := os.ReadFile(s.indexPath()); err == nil {
		json.Unmarshal(data, &s.index)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	var workspace Workspace
	if data, err := os.ReadFile(s.manifestPath()); err == nil {
		json.Unmarshal(data, &workspace)
	}
	tabs := map[string]Tab{}
	for _, tab := range workspace.Tabs {
		tabs[tab.ID] = tab
	}
	files, _ := filepath.Glob(filepath.Join(s.dir, "*.sql"))
	changed := false
	for _, path := range files {
		id := strings.TrimSuffix(filepath.Base(path), ".sql")
		if !validID.MatchString(id) || s.index[id] != nil {
			continue
		}
		fileInfo, err := os.Stat(path)
		if err != nil {
			continue
		}
		record := &metadata{Name: id + ".sql", CreatedAt: fileInfo.ModTime().UnixMilli(), UpdatedAt: fileInfo.ModTime().UnixMilli()}
		if tab, ok := tabs[id]; ok {
			record.Name, record.ConnID, record.Database, record.Locked = tab.Name, tab.ConnID, tab.Database, tab.Locked
		}
		s.index[id] = record
		changed = true
	}
	// Forget entries whose file disappeared.
	for id := range s.index {
		if path, _ := s.filePath(id); path == "" || !exists(path) {
			delete(s.index, id)
			changed = true
		}
	}
	if changed {
		return s.writeIndex()
	}
	return nil
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func (s *Store) writeIndex() error {
	return jsonfile.Write(s.indexPath(), s.index, 0o600)
}

// Load returns the open tabs; SQL tabs carry their scratch's content and link.
func (s *Store) Load() (Workspace, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	workspace := Workspace{Tabs: []Tab{}}
	data, err := os.ReadFile(s.manifestPath())
	if errors.Is(err, os.ErrNotExist) {
		return workspace, nil
	}
	if err != nil {
		return workspace, err
	}
	if err := json.Unmarshal(data, &workspace); err != nil {
		return Workspace{Tabs: []Tab{}}, nil // corrupt manifest: start fresh
	}
	tabs := workspace.Tabs[:0]
	for _, tab := range workspace.Tabs {
		if tab.Kind == "" || tab.Kind == "sql" {
			record := s.index[tab.ID]
			if record == nil {
				continue // its scratch was deleted
			}
			tab.Name, tab.ConnID, tab.Database, tab.Locked = record.Name, record.ConnID, record.Database, record.Locked
			if path, err := s.filePath(tab.ID); err == nil {
				content, _ := os.ReadFile(path)
				tab.Content = string(content)
			}
		}
		tabs = append(tabs, tab)
	}
	workspace.Tabs = tabs
	return workspace, nil
}

// SaveLayout writes the open tabs and keeps the scratch index in sync with
// the names and links of open SQL tabs.
func (s *Store) SaveLayout(workspace Workspace) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	saved := Workspace{ActiveID: workspace.ActiveID, Tabs: make([]Tab, 0, len(workspace.Tabs))}
	changed := false
	for _, tab := range workspace.Tabs {
		path, err := s.filePath(tab.ID)
		if err != nil {
			return err
		}
		tab.Content = ""
		if tab.Kind == "" || tab.Kind == "sql" {
			record := s.index[tab.ID]
			if record == nil {
				// A new scratch is pinned to the link it was created with; only a
				// scratch with no connection at all stays free to move.
				record = &metadata{ConnID: tab.ConnID, Database: tab.Database, Locked: tab.ConnID != "", CreatedAt: now(), UpdatedAt: now()}
				s.index[tab.ID] = record
				if !exists(path) {
					_ = atomicfile.Write(path, nil, 0o600)
				}
			}
			if record.Locked {
				// A locked scratch keeps its link whatever this tab (or a bug) says.
				tab.ConnID, tab.Database = record.ConnID, record.Database
			} else if record.ConnID != tab.ConnID || record.Database != tab.Database {
				// Moved to another connection or database: the table link no longer applies.
				record.Schema, record.Table = "", ""
			}
			if record.Name != tab.Name || record.ConnID != tab.ConnID || record.Database != tab.Database {
				record.Name, record.ConnID, record.Database = tab.Name, tab.ConnID, tab.Database
				changed = true
			}
			tab.Locked = record.Locked
			changed = changed || record.CreatedAt == 0
		}
		saved.Tabs = append(saved.Tabs, tab)
	}
	if changed {
		if err := s.writeIndex(); err != nil {
			return err
		}
	}
	return jsonfile.Write(s.manifestPath(), saved, 0o600)
}

// SaveContent writes a scratch's content.
func (s *Store) SaveContent(id, content string) error {
	path, err := s.filePath(id)
	if err != nil {
		return err
	}
	if err := atomicfile.Write(path, []byte(content), 0o600); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	record := s.index[id]
	if record == nil {
		record = &metadata{Name: id + ".sql", CreatedAt: now()}
		s.index[id] = record
	}
	record.UpdatedAt = now()
	return s.writeIndex()
}

// List returns every scratch, most recently edited first.
func (s *Store) List() []Info {
	s.mu.Lock()
	defer s.mu.Unlock()
	infos := make([]Info, 0, len(s.index))
	for id, record := range s.index {
		info := Info{ID: id, Name: record.Name, ConnID: record.ConnID, Database: record.Database, Schema: record.Schema, Table: record.Table, Locked: record.Locked, CreatedAt: record.CreatedAt, UpdatedAt: record.UpdatedAt}
		if path, err := s.filePath(id); err == nil {
			if data, err := os.ReadFile(path); err == nil {
				info.Size = len(data)
				info.Preview = preview(string(data))
			}
		}
		infos = append(infos, info)
	}
	sort.Slice(infos, func(i, j int) bool { return infos[i].UpdatedAt > infos[j].UpdatedAt })
	return infos
}

// preview returns the first line that is not blank or a comment marker only.
func preview(content string) string {
	for line := range strings.SplitSeq(content, "\n") {
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
	path, err := s.filePath(id)
	if err != nil {
		return Tab{}, err
	}
	s.mu.Lock()
	record := s.index[id]
	s.mu.Unlock()
	if record == nil {
		return Tab{}, fmt.Errorf("scratch %s not found", id)
	}
	data, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return Tab{}, err
	}
	return Tab{ID: id, Name: record.Name, ConnID: record.ConnID, Database: record.Database, Kind: "sql", Locked: record.Locked, Content: string(data)}, nil
}

// Create adds a scratch file and returns it. Schema and table optionally file
// it under a table. New scratches are locked to their link unless they have no
// connection yet.
func (s *Store) Create(id, name, connID, database, schema, table, content string) (Tab, error) {
	path, err := s.filePath(id)
	if err != nil {
		return Tab{}, err
	}
	name, err = CleanName(name)
	if err != nil {
		return Tab{}, err
	}
	if err := atomicfile.Write(path, []byte(content), 0o600); err != nil {
		return Tab{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	locked := connID != ""
	s.index[id] = &metadata{Name: name, ConnID: connID, Database: database, Schema: schema, Table: table, Locked: locked, CreatedAt: now(), UpdatedAt: now()}
	return Tab{ID: id, Name: name, ConnID: connID, Database: database, Kind: "sql", Locked: locked, Content: content}, s.writeIndex()
}

// Link files a scratch under a connection, database and optionally a table.
// A locked scratch refuses to move until it is unlocked.
func (s *Store) Link(id, connID, database, schema, table string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	record := s.index[id]
	if record == nil {
		return fmt.Errorf("scratch %s not found", id)
	}
	if table == "" {
		schema = ""
	}
	if record.Locked && (record.ConnID != connID || record.Database != database || record.Schema != schema || record.Table != table) {
		return fmt.Errorf("scratch %s is locked to %s; unlock it first", id, record.Name)
	}
	record.ConnID, record.Database, record.Schema, record.Table = connID, database, schema, table
	record.UpdatedAt = now()
	return s.writeIndex()
}

// SetLock pins or unpins a scratch's connection, database and folder link.
func (s *Store) SetLock(id string, locked bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	record := s.index[id]
	if record == nil {
		return fmt.Errorf("scratch %s not found", id)
	}
	record.Locked = locked
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
	record := s.index[id]
	if record == nil {
		return "", fmt.Errorf("scratch %s not found", id)
	}
	record.Name = name
	record.UpdatedAt = now()
	return name, s.writeIndex()
}

// Snapshot returns every scratch with its content, for git sync.
func (s *Store) Snapshot() ([]Entry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries := make([]Entry, 0, len(s.index))
	for id, record := range s.index {
		path, err := s.filePath(id)
		if err != nil {
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		entries = append(entries, Entry{
			ID: id, Name: record.Name, ConnID: record.ConnID, Database: record.Database, Schema: record.Schema, Table: record.Table,
			CreatedAt: record.CreatedAt, UpdatedAt: record.UpdatedAt, Content: string(data),
		})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].ID < entries[j].ID })
	return entries, nil
}

// Replace makes the entries the whole set of scratches, deleting files that
// are no longer part of the merged set. Git sync owns the merge itself.
func (s *Store) Replace(entries []Entry) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	keep := make(map[string]bool, len(entries))
	for _, entry := range entries {
		if !validID.MatchString(entry.ID) {
			return fmt.Errorf("invalid scratch id %q", entry.ID)
		}
		keep[entry.ID] = true
	}
	// Locks are local preferences, not part of the synced entry: keep them.
	locked := make(map[string]bool, len(s.index))
	for id, record := range s.index {
		if record.Locked {
			locked[id] = true
		}
	}
	for id := range s.index {
		if keep[id] {
			continue
		}
		path, err := s.filePath(id)
		if err != nil {
			return err
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	index := make(map[string]*metadata, len(entries))
	for _, entry := range entries {
		name, err := CleanName(entry.Name)
		if err != nil {
			return err
		}
		path, err := s.filePath(entry.ID)
		if err != nil {
			return err
		}
		if err := atomicfile.Write(path, []byte(entry.Content), 0o600); err != nil {
			return err
		}
		index[entry.ID] = &metadata{
			Name: name, ConnID: entry.ConnID, Database: entry.Database, Schema: entry.Schema, Table: entry.Table,
			Locked: locked[entry.ID], CreatedAt: entry.CreatedAt, UpdatedAt: entry.UpdatedAt,
		}
	}
	s.index = index
	return s.writeIndex()
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
	path, err := s.filePath(id)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.index, id)
	return s.writeIndex()
}

// IsBlank reports whether a scratch is empty (only whitespace). Tabs without a
// scratch file (data editors, diagrams) are never blank scratches.
func (s *Store) IsBlank(id string) bool {
	s.mu.Lock()
	_, tracked := s.index[id]
	s.mu.Unlock()
	if !tracked {
		return false
	}
	path, err := s.filePath(id)
	if err != nil {
		return false
	}
	data, err := os.ReadFile(path)
	return err != nil || strings.TrimSpace(string(data)) == ""
}
