// Package conn persists connection definitions and manages open pools.
package conn

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"dolmen/internal/driver"
	"dolmen/internal/jsonfile"
	"dolmen/internal/sshtunnel"
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
	configs, err := s.List()
	if err != nil {
		return driver.Config{}, err
	}
	for _, config := range configs {
		if config.ID == id {
			return config, nil
		}
	}
	return driver.Config{}, fmt.Errorf("connection %s not found", id)
}

// Save inserts or replaces a connection and returns it (with an ID).
func (s *Store) Save(config driver.Config) (driver.Config, error) {
	if err := validate(config); err != nil {
		return config, err
	}
	config.UpdatedAt = time.Now().UnixMilli()
	s.mu.Lock()
	defer s.mu.Unlock()
	configs, err := s.load()
	if err != nil {
		return config, err
	}
	if config.ID == "" {
		config.ID = uuid.NewString()
		configs = append(configs, config)
	} else {
		found := false
		for i := range configs {
			if configs[i].ID == config.ID {
				configs[i], found = config, true
			}
		}
		if !found {
			configs = append(configs, config)
		}
	}
	return config, s.write(configs)
}

func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	configs, err := s.load()
	if err != nil {
		return err
	}
	out := configs[:0]
	for _, config := range configs {
		if config.ID != id {
			out = append(out, config)
		}
	}
	return s.write(out)
}

// SetFolder files a connection under an explorer folder ("" = root).
func (s *Store) SetFolder(id, folderID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	configs, err := s.load()
	if err != nil {
		return err
	}
	for i := range configs {
		if configs[i].ID == id {
			configs[i].FolderID = folderID
			configs[i].UpdatedAt = time.Now().UnixMilli()
			return s.write(configs)
		}
	}
	return fmt.Errorf("connection %s not found", id)
}

// Replace rewrites the whole connection list (used by git sync, which
// already merged the copies of every machine).
func (s *Store) Replace(configs []driver.Config) error {
	if configs == nil {
		configs = []driver.Config{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	sortConfigs(configs)
	return s.write(configs)
}

func (s *Store) load() ([]driver.Config, error) {
	var configs []driver.Config
	found, err := jsonfile.Read(s.path, &configs)
	if err != nil {
		return nil, err
	}
	if !found {
		return []driver.Config{}, nil
	}
	sortConfigs(configs)
	return configs, nil
}

// sortConfigs orders connections by name, case-insensitively.
func sortConfigs(configs []driver.Config) {
	sort.SliceStable(configs, func(i, j int) bool {
		return strings.ToLower(configs[i].Name) < strings.ToLower(configs[j].Name)
	})
}

func (s *Store) write(configs []driver.Config) error {
	return jsonfile.Write(s.path, configs, 0o600)
}

func validate(config driver.Config) error {
	if strings.TrimSpace(config.Name) == "" {
		return errors.New("name is required")
	}
	if _, err := driver.Get(config.Kind); err != nil {
		return err
	}
	if config.Kind == driver.SQLite && config.FilePath == "" {
		return errors.New("a database file is required")
	}
	if config.SSH != nil && config.SSH.Enabled {
		if config.Kind == driver.SQLite {
			return errors.New("SQLite files cannot be reached through SSH")
		}
		if strings.TrimSpace(config.SSH.Host) == "" {
			return errors.New("an SSH host is required")
		}
		if strings.TrimSpace(config.SSH.User) == "" {
			return errors.New("an SSH user is required")
		}
		switch config.SSH.Method {
		case "", "password":
			if config.SSH.Password == "" {
				return errors.New("an SSH password is required")
			}
		case "key":
			if strings.TrimSpace(config.SSH.KeyPath) == "" {
				return errors.New("an SSH private key is required")
			}
		case "agent":
		default:
			return fmt.Errorf("unknown SSH authentication method %q", config.SSH.Method)
		}
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

	tunnel *sshtunnel.Tunnel
}

// Close releases the pool and, when one was used, the SSH tunnel.
func (connection *Open) Close() error {
	err := connection.DB.Close()
	if connection.tunnel != nil {
		connection.tunnel.Close()
	}
	return err
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
func Dial(ctx context.Context, config driver.Config) (*Open, error) {
	databaseDriver, err := driver.Get(config.Kind)
	if err != nil {
		return nil, err
	}
	target := config
	var tunnel *sshtunnel.Tunnel
	if config.SSH != nil && config.SSH.Enabled {
		tunnel, err = sshTunnel(ctx, config)
		if err != nil {
			return nil, err
		}
		target.Host, target.Port = tunnel.Host(), tunnel.Port()
	}
	dsn, err := databaseDriver.DSN(target)
	if err != nil {
		closeTunnel(tunnel)
		return nil, err
	}
	db, err := sql.Open(databaseDriver.SQLDriverName(), dsn)
	if err != nil {
		closeTunnel(tunnel)
		return nil, err
	}
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(3)
	db.SetConnMaxIdleTime(5 * time.Minute)
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		closeTunnel(tunnel)
		return nil, err
	}
	opened := &Open{Config: config, Driver: databaseDriver, DB: db, tunnel: tunnel}
	if lister, ok := databaseDriver.(driver.DatabaseLister); ok {
		opened.CurrentDB, _ = lister.CurrentDatabase(ctx, db)
	}
	return opened, nil
}

// sshTunnel forwards a local port to the connection's server. The DSN then
// points at that port, so every driver keeps working unchanged.
func sshTunnel(ctx context.Context, config driver.Config) (*sshtunnel.Tunnel, error) {
	host := config.Host
	if host == "" {
		host = "localhost"
	}
	port := config.Port
	if port == 0 {
		port = driver.DefaultPort(config.Kind)
	}
	if port == 0 {
		return nil, fmt.Errorf("an SSH tunnel needs the database port")
	}
	tunnel, err := sshtunnel.Open(ctx, *config.SSH, net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		return nil, fmt.Errorf("SSH tunnel: %w", err)
	}
	return tunnel, nil
}

func closeTunnel(tunnel *sshtunnel.Tunnel) {
	if tunnel != nil {
		tunnel.Close()
	}
}

// Connect opens (or reopens) the pool for config.
func (m *Manager) Connect(ctx context.Context, config driver.Config) (*Open, error) {
	opened, err := Dial(ctx, config)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	previous := m.open[config.ID]
	m.open[config.ID] = &entry{main: opened, extra: map[string]*Open{}}
	m.mu.Unlock()
	previous.close()
	return opened, nil
}

// Get returns the main pool of a connection.
func (m *Manager) Get(id string) (*Open, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	pool, ok := m.open[id]
	if !ok {
		return nil, errors.New("not connected")
	}
	return pool.main, nil
}

// GetDB returns the pool for another database of the same server, opening
// it on first use. "" or the main pool's database return the main pool.
func (m *Manager) GetDB(ctx context.Context, id, database string) (*Open, error) {
	m.mu.RLock()
	pool, ok := m.open[id]
	var extra *Open
	if ok {
		extra = pool.extra[database]
	}
	m.mu.RUnlock()
	if !ok {
		return nil, errors.New("not connected")
	}
	if database == "" || database == pool.main.CurrentDB {
		return pool.main, nil
	}
	if extra != nil {
		return extra, nil
	}
	if _, isLister := pool.main.Driver.(driver.DatabaseLister); !isLister {
		return nil, fmt.Errorf("%s connections have no database level", pool.main.Config.Kind)
	}
	config := pool.main.Config
	config.Database = database
	opened, err := Dial(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("database %s: %w", database, err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	current, ok := m.open[id]
	if !ok || current != pool {
		opened.Close() // disconnected or reconnected meanwhile
		return nil, errors.New("not connected")
	}
	if existing := pool.extra[database]; existing != nil {
		opened.Close() // lost a race with another caller
		return existing, nil
	}
	pool.extra[database] = opened
	return opened, nil
}

// CloseDB closes the pool opened for another database of the connection.
func (m *Manager) CloseDB(id, database string) {
	m.mu.Lock()
	var extra *Open
	if pool := m.open[id]; pool != nil {
		extra = pool.extra[database]
		delete(pool.extra, database)
	}
	m.mu.Unlock()
	if extra != nil {
		extra.Close()
	}
}

func (m *Manager) Disconnect(id string) {
	m.mu.Lock()
	pool := m.open[id]
	delete(m.open, id)
	m.mu.Unlock()
	pool.close()
}

func (pool *entry) close() {
	if pool == nil {
		return
	}
	pool.main.Close()
	for _, extra := range pool.extra {
		extra.Close()
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
