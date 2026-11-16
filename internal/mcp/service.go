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
	store   *Store
	conns   *conn.Manager
	saved   *conn.Store
	hist    *history.Store
	version string

	mu      sync.Mutex
	cfg     Config
	running bool
	lastErr string
	srv     *http.Server
	ln      net.Listener
	// policy is the live snapshot read by tools and the HTTP handler, so
	// saving permissions or a token does not require restarting the server.
	policy atomic.Pointer[Config]
}

// NewService opens the settings file and prepares the server. Call Start to
// listen when the settings enable it.
func NewService(dir string, conns *conn.Manager, saved *conn.Store, hist *history.Store, version string) (*Service, error) {
	store, err := NewStore(dir)
	if err != nil {
		return nil, err
	}
	cfg, err := store.Load()
	if err != nil {
		return nil, err
	}
	cfg = cfg.Normalize()
	if cfg.Token == "" {
		token, err := NewToken()
		if err != nil {
			return nil, err
		}
		cfg.Token = token
		if err := store.Save(cfg); err != nil {
			return nil, err
		}
	}
	s := &Service{store: store, conns: conns, saved: saved, hist: hist, version: version, cfg: cfg}
	s.policy.Store(&cfg)
	return s, nil
}

// Status reports the saved settings and whether the server is listening.
func (s *Service) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.statusLocked()
}

func (s *Service) statusLocked() Status {
	st := Status{Config: s.cfg, Running: s.running, LastError: s.lastErr}
	st.URL = fmt.Sprintf("http://127.0.0.1:%d%s", s.cfg.Port, EndpointPath)
	return st
}

// Save validates and persists the settings, then applies them: the listener
// starts, stops or moves to another port as needed. A failure to listen (a
// busy port, for instance) is reported in Status.LastError rather than as an
// error, because the settings themselves were saved.
func (s *Service) Save(cfg Config) (Status, error) {
	cfg = cfg.Normalize()
	if cfg.Token == "" {
		token, err := NewToken()
		if err != nil {
			return s.Status(), err
		}
		cfg.Token = token
	}
	if err := cfg.Validate(); err != nil {
		return s.Status(), err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.store.Save(cfg); err != nil {
		return s.statusLocked(), err
	}
	previous := s.cfg
	s.cfg = cfg
	s.policy.Store(&cfg)
	if s.running && (!cfg.Enabled || cfg.Port != previous.Port) {
		s.stopLocked()
	}
	if cfg.Enabled && !s.running {
		if err := s.startLocked(); err != nil {
			s.lastErr = err.Error()
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
	if !s.cfg.Enabled {
		return errors.New("the MCP server is disabled")
	}
	return s.startLocked()
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
	tools := NewTools(s.conns, s.saved, s.hist, policy)
	handler := NewHandler(tools, policy, s.version)
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", s.cfg.Port))
	if err != nil {
		return fmt.Errorf("listening on port %d: %w", s.cfg.Port, err)
	}
	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      2 * time.Minute,
		IdleTimeout:       2 * time.Minute,
	}
	s.ln, s.srv, s.running, s.lastErr = ln, srv, true, ""
	go func() {
		// A closed listener ends Serve with ErrServerClosed; nothing to do.
		_ = srv.Serve(ln)
	}()
	return nil
}

func (s *Service) stopLocked() {
	if s.srv != nil {
		_ = s.srv.Close()
	}
	s.srv, s.ln, s.running = nil, nil, false
}

// RegenerateToken replaces the bearer token clients must send. Connected
// clients keep their session until their next request.
func (s *Service) RegenerateToken() (Status, error) {
	s.mu.Lock()
	cfg := s.cfg
	s.mu.Unlock()
	token, err := NewToken()
	if err != nil {
		return s.Status(), err
	}
	cfg.Token = token
	return s.Save(cfg)
}
