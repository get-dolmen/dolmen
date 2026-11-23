package mcp

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"dolmen/internal/conn"
	"dolmen/internal/history"
)

// Status is the settings dialog's view of the server.
type Status struct {
	Config
	Running   bool   `json:"running"`
	URL       string `json:"url"`
	LastError string `json:"lastError,omitempty"`
}

// Service owns the settings file and the running HTTP listener.
type Service struct {
	store            *Store
	connections      *conn.Manager
	savedConnections *conn.Store
	historyStore     *history.Store
	version          string

	mu        sync.Mutex
	config    Config
	running   bool
	lastError string
	server    *http.Server
	listener  net.Listener
	// policy is the live snapshot read by tools and the HTTP handler, so
	// saving permissions or a token does not require restarting the server.
	policy atomic.Pointer[Config]
}

// NewService opens the settings file and prepares the server. Call Start to
// listen when the settings enable it.
func NewService(dir string, connections *conn.Manager, savedConnections *conn.Store, historyStore *history.Store, version string) (*Service, error) {
	store, err := NewStore(dir)
	if err != nil {
		return nil, err
	}
	config, err := store.Load()
	if err != nil {
		return nil, err
	}
	config = config.Normalize()
	if config.Token == "" {
		token, err := NewToken()
		if err != nil {
			return nil, err
		}
		config.Token = token
		if err := store.Save(config); err != nil {
			return nil, err
		}
	}
	s := &Service{store: store, connections: connections, savedConnections: savedConnections, historyStore: historyStore, version: version, config: config}
	s.policy.Store(&config)
	return s, nil
}

// Status reports the saved settings and whether the server is listening.
func (s *Service) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.statusLocked()
}

func (s *Service) statusLocked() Status {
	status := Status{Config: s.config, Running: s.running, LastError: s.lastError}
	status.URL = fmt.Sprintf("http://127.0.0.1:%d%s", s.config.Port, EndpointPath)
	return status
}

// Save validates and persists the settings, then applies them: the listener
// starts, stops or moves to another port as needed. A failure to listen (a
// busy port, for instance) is reported in Status.LastError rather than as an
// error, because the settings themselves were saved.
func (s *Service) Save(config Config) (Status, error) {
	config = config.Normalize()
	if config.Token == "" {
		token, err := NewToken()
		if err != nil {
			return s.Status(), err
		}
		config.Token = token
	}
	if err := config.Validate(); err != nil {
		return s.Status(), err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.store.Save(config); err != nil {
		return s.statusLocked(), err
	}
	previous := s.config
	s.config = config
	s.policy.Store(&config)
	if s.running && (!config.Enabled || config.Port != previous.Port) {
		s.stopLocked()
	}
	if config.Enabled && !s.running {
		if err := s.startLocked(); err != nil {
			s.lastError = err.Error()
		}
	}
	return s.statusLocked(), nil
}

// Start begins listening if the saved settings allow it.
func (s *Service) Start() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.running {
		return nil
	}
	if !s.config.Enabled {
		return errors.New("the MCP server is disabled")
	}
	if err := s.config.Validate(); err != nil {
		s.lastError = err.Error()
		return err
	}
	if err := s.startLocked(); err != nil {
		s.lastError = err.Error()
		return err
	}
	return nil
}

// Stop closes the listener. The settings keep Enabled, so the next launch
// starts the server again.
func (s *Service) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stopLocked()
}

func (s *Service) startLocked() error {
	policy := func() Config { return *s.policy.Load() }
	tools := NewTools(s.connections, s.savedConnections, s.historyStore, policy)
	handler := NewHandler(tools, policy, s.version)
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", s.config.Port))
	if err != nil {
		return fmt.Errorf("listening on port %d: %w", s.config.Port, err)
	}
	server := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      2 * time.Minute,
		IdleTimeout:       2 * time.Minute,
	}
	s.listener, s.server, s.running, s.lastError = listener, server, true, ""
	go func() {
		// A closed listener ends Serve with ErrServerClosed; nothing to do.
		_ = server.Serve(listener)
	}()
	return nil
}

func (s *Service) stopLocked() {
	if s.server != nil {
		_ = s.server.Close()
	}
	// Serve runs in a goroutine: if it has not registered the listener yet,
	// server.Close misses it and the port stays bound until Serve gets to run.
	// Close it here so a restart can listen on the same port right away.
	if s.listener != nil {
		_ = s.listener.Close()
	}
	s.server, s.listener, s.running = nil, nil, false
}

// RegenerateToken replaces the bearer token clients must send. Connected
// clients keep their session until their next request.
func (s *Service) RegenerateToken() (Status, error) {
	s.mu.Lock()
	config := s.config
	s.mu.Unlock()
	token, err := NewToken()
	if err != nil {
		return s.Status(), err
	}
	config.Token = token
	return s.Save(config)
}
