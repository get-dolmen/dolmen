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
	config, err := s.Load()
	if err != nil {
		return nil, err
	}
	if err := s.Save(config); err != nil {
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
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return DefaultConfig(), nil
	}
	if err != nil {
		return Config{}, err
	}
	var config Config
	if err := json.Unmarshal(data, &config); err != nil {
		return Config{}, fmt.Errorf("reading %s: %w", s.path, err)
	}
	return config.Normalize(), nil
}

// Save writes the settings, generating an access token when none is set.
func (s *Store) Save(config Config) error {
	config = config.Normalize()
	if config.Token == "" {
		token, err := NewToken()
		if err != nil {
			return err
		}
		config.Token = token
	}
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	return atomicfile.Write(s.path, data, 0o600)
}

// NewToken returns a random bearer token for local MCP clients.
func NewToken() (string, error) {
	data := make([]byte, 32)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}
