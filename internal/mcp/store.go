package mcp

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"dolmen/internal/atomicfile"
)

// Store persists the MCP settings as mcp.json next to Dolmen's other files.
type Store struct {
	path string
	mu   sync.Mutex
}

// NewStore opens the settings file, creating it with defaults and a fresh
// access token on first use. The file is private (0600): it holds the token.
func NewStore(dir string) (*Store, error) {
	s := &Store{path: filepath.Join(dir, "mcp.json")}
	cfg, err := s.Load()
	if err != nil {
		return nil, err
	}
	if err := s.Save(cfg); err != nil {
		return nil, err
	}
	return s, nil
}

// Path is the settings file's location.
func (s *Store) Path() string { return s.path }

// Load returns the saved settings, or the defaults before the first save.
func (s *Store) Load() (Config, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.load()
}

func (s *Store) load() (Config, error) {
	b, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return DefaultConfig(), nil
	}
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	if err := json.Unmarshal(b, &cfg); err != nil {
		return Config{}, fmt.Errorf("reading %s: %w", s.path, err)
	}
	return cfg.Normalize(), nil
}

// Save writes the settings, generating an access token when none is set.
func (s *Store) Save(cfg Config) error {
	cfg = cfg.Normalize()
	if cfg.Token == "" {
		token, err := NewToken()
		if err != nil {
			return err
		}
		cfg.Token = token
	}
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	return atomicfile.Write(s.path, b, 0o600)
}

// NewToken returns a random bearer token for local MCP clients.
func NewToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
