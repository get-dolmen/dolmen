// Package conn persists connection definitions and manages open pools.
package conn

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"dolmen/internal/driver"
)

// Store keeps saved connections in a JSON file (0600, passwords included
// until keychain support lands).
type Store struct {
	path string
	mu   sync.Mutex
}

func NewStore(dir string) *Store { return &Store{path: filepath.Join(dir, "connections.json")} }

func (s *Store) List() ([]driver.Config, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.load()
}

func (s *Store) Get(id string) (driver.Config, error) {
	cfgs, err := s.List()
	if err != nil {
		return driver.Config{}, err
	}
	for _, c := range cfgs {
		if c.ID == id {
			return c, nil
		}
	}
	return driver.Config{}, fmt.Errorf("connection %s not found", id)
}

// Save inserts or replaces a connection and returns it (with an ID).
func (s *Store) Save(cfg driver.Config) (driver.Config, error) {
	if err := validate(cfg); err != nil {
		return cfg, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cfgs, err := s.load()
	if err != nil {
		return cfg, err
	}
	if cfg.ID == "" {
		cfg.ID = uuid.NewString()
		cfgs = append(cfgs, cfg)
	} else {
		found := false
		for i := range cfgs {
			if cfgs[i].ID == cfg.ID {
				cfgs[i], found = cfg, true
			}
		}
		if !found {
			cfgs = append(cfgs, cfg)
		}
	}
	return cfg, s.write(cfgs)
}

func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cfgs, err := s.load()
	if err != nil {
		return err
	}
	out := cfgs[:0]
	for _, c := range cfgs {
		if c.ID != id {
			out = append(out, c)
		}
	}
	return s.write(out)
}

func (s *Store) load() ([]driver.Config, error) {
	b, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return []driver.Config{}, nil
	}
	if err != nil {
		return nil, err
	}
	var cfgs []driver.Config
	if err := json.Unmarshal(b, &cfgs); err != nil {
		return nil, fmt.Errorf("reading %s: %w", s.path, err)
	}
	sort.SliceStable(cfgs, func(i, j int) bool { return strings.ToLower(cfgs[i].Name) < strings.ToLower(cfgs[j].Name) })
	return cfgs, nil
}

func (s *Store) write(cfgs []driver.Config) error {
	b, err := json.MarshalIndent(cfgs, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func validate(c driver.Config) error {
	if strings.TrimSpace(c.Name) == "" {
		return errors.New("name is required")
	}
	if _, err := driver.Get(c.Kind); err != nil {
		return err
	}
	if c.Kind == driver.SQLite && c.FilePath == "" {
		return errors.New("a database file is required")
	}
	return nil
}

// Open is a live connection pool.
type Open struct {
	Config driver.Config
	Driver driver.Driver
	DB     *sql.DB
	// CurrentDB is the database the pool is connected to, for engines with a
	// database level (Postgres); "" otherwise.
	CurrentDB string
}

// entry is a saved connection's main pool plus the pools opened for other
// databases on the same server.
type entry struct {
	main  *Open
	extra map[string]*Open
}

// Manager tracks open pools by connection ID.
type Manager struct {
	mu   sync.RWMutex
	open map[string]*entry
}

func NewManager() *Manager { return &Manager{open: map[string]*entry{}} }

// Dial opens and pings a pool without registering it.
func Dial(ctx context.Context, cfg driver.Config) (*Open, error) {
	d, err := driver.Get(cfg.Kind)
	if err != nil {
		return nil, err
	}
	dsn, err := d.DSN(cfg)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open(d.SQLDriverName(), dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(3)
	db.SetConnMaxIdleTime(5 * time.Minute)
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, err
	}
	o := &Open{Config: cfg, Driver: d, DB: db}
	if l, ok := d.(driver.DatabaseLister); ok {
		o.CurrentDB, _ = l.CurrentDatabase(ctx, db)
	}
	return o, nil
}

// Connect opens (or reopens) the pool for cfg.
func (m *Manager) Connect(ctx context.Context, cfg driver.Config) (*Open, error) {
	o, err := Dial(ctx, cfg)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	old := m.open[cfg.ID]
	m.open[cfg.ID] = &entry{main: o, extra: map[string]*Open{}}
	m.mu.Unlock()
	old.close()
	return o, nil
}

// Get returns the main pool of a connection.
func (m *Manager) Get(id string) (*Open, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	e, ok := m.open[id]
	if !ok {
		return nil, errors.New("not connected")
	}
	return e.main, nil
}

// GetDB returns the pool for another database of the same server, opening
// it on first use. "" or the main pool's database return the main pool.
func (m *Manager) GetDB(ctx context.Context, id, database string) (*Open, error) {
	m.mu.RLock()
	e, ok := m.open[id]
	var x *Open
	if ok {
		x = e.extra[database]
	}
	m.mu.RUnlock()
	if !ok {
		return nil, errors.New("not connected")
	}
	if database == "" || database == e.main.CurrentDB {
		return e.main, nil
	}
	if x != nil {
		return x, nil
	}
	if _, ok := e.main.Driver.(driver.DatabaseLister); !ok {
		return nil, fmt.Errorf("%s connections have no database level", e.main.Config.Kind)
	}
	cfg := e.main.Config
	cfg.Database = database
	o, err := Dial(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("database %s: %w", database, err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	cur, ok := m.open[id]
	if !ok || cur != e {
		o.DB.Close() // disconnected or reconnected meanwhile
		return nil, errors.New("not connected")
	}
	if existing := e.extra[database]; existing != nil {
		o.DB.Close() // lost a race with another caller
		return existing, nil
	}
	e.extra[database] = o
	return o, nil
}

func (m *Manager) Disconnect(id string) {
	m.mu.Lock()
	e := m.open[id]
	delete(m.open, id)
	m.mu.Unlock()
	e.close()
}

func (e *entry) close() {
	if e == nil {
		return
	}
	e.main.DB.Close()
	for _, x := range e.extra {
		x.DB.Close()
	}
}

func (m *Manager) OpenIDs() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	ids := make([]string, 0, len(m.open))
	for id := range m.open {
		ids = append(ids, id)
	}
	return ids
}

func (m *Manager) CloseAll() {
	for _, id := range m.OpenIDs() {
		m.Disconnect(id)
	}
}
