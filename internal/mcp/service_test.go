package mcp

import (
	"net"
	"net/http"
	"strings"
	"testing"

	"dolmen/internal/conn"
)

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	return port
}

func ping(t *testing.T, url, token string) int {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	return resp.StatusCode
}

func newTestService(t *testing.T) *Service {
	t.Helper()
	service, err := NewService(t.TempDir(), conn.NewManager(), conn.NewStore(t.TempDir()), nil, "test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(service.Stop)
	return service
}

func TestServiceStartsAndStops(t *testing.T) {
	s := newTestService(t)
	st := s.Status()
	if st.Enabled || st.Running || st.Token == "" || !st.Read || st.Write {
		t.Fatalf("initial status = %+v", st)
	}
	if st.URL != "http://127.0.0.1:8770/mcp" {
		t.Fatalf("url = %q", st.URL)
	}
	if err := s.Start(); err == nil {
		t.Fatal("Start succeeded while disabled")
	}

	port := freePort(t)
	st, err := s.Save(Config{Enabled: true, Port: port, Read: true, Token: st.Token})
	if err != nil {
		t.Fatal(err)
	}
	if !st.Running || st.LastError != "" {
		t.Fatalf("status after start = %+v", st)
	}
	if code := ping(t, st.URL, st.Token); code != http.StatusOK {
		t.Fatalf("ping: status %d", code)
	}

	if st, err = s.Save(Config{Enabled: false, Port: port, Read: true, Token: st.Token}); err != nil {
		t.Fatal(err)
	}
	if st.Running {
		t.Fatalf("status after stop = %+v", st)
	}
	req, _ := http.NewRequest(http.MethodPost, st.URL, strings.NewReader(`{}`))
	if _, err := http.DefaultClient.Do(req); err == nil {
		t.Fatal("the listener still accepts connections after Stop")
	}
}

func TestServiceSavesPermissionsWithoutRestart(t *testing.T) {
	s := newTestService(t)
	port := freePort(t)
	st, err := s.Save(Config{Enabled: true, Port: port, Read: true, Token: s.Status().Token})
	if err != nil {
		t.Fatal(err)
	}
	st, err = s.Save(Config{Enabled: true, Port: port, Read: true, Write: true, Token: st.Token,
		Databases: []string{" sales ", "sales"}, Schemas: []string{"public"}})
	if err != nil {
		t.Fatal(err)
	}
	if !st.Running || !st.Write || len(st.Databases) != 1 {
		t.Fatalf("status = %+v", st)
	}
	// The same listener is still alive on the same port.
	if code := ping(t, st.URL, st.Token); code != http.StatusOK {
		t.Fatalf("ping after save: status %d", code)
	}
}

func TestServiceRegeneratesToken(t *testing.T) {
	s := newTestService(t)
	port := freePort(t)
	st, err := s.Save(Config{Enabled: true, Port: port, Read: true, Token: s.Status().Token})
	if err != nil {
		t.Fatal(err)
	}
	old := st.Token
	st, err = s.RegenerateToken()
	if err != nil {
		t.Fatal(err)
	}
	if st.Token == old || st.Token == "" {
		t.Fatal("the token did not change")
	}
	if code := ping(t, st.URL, old); code != http.StatusUnauthorized {
		t.Fatalf("old token: status %d", code)
	}
	if code := ping(t, st.URL, st.Token); code != http.StatusOK {
		t.Fatalf("new token: status %d", code)
	}
}

func TestServiceRejectsInvalidSettings(t *testing.T) {
	s := newTestService(t)
	port := freePort(t)
	token := s.Status().Token
	for _, cfg := range []Config{
		{Enabled: true, Port: port, Token: token},
		{Enabled: true, Port: -1, Read: true, Token: token},
		{Enabled: true, Port: 70000, Read: true, Token: token},
	} {
		if _, err := s.Save(cfg); err == nil {
			t.Errorf("invalid config accepted: %+v", cfg)
		}
	}
}

func TestServiceReportsBusyPort(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port

	s := newTestService(t)
	st, err := s.Save(Config{Enabled: true, Port: port, Read: true, Token: s.Status().Token})
	if err != nil {
		t.Fatal(err)
	}
	if st.Running || st.LastError == "" {
		t.Fatalf("status = %+v", st)
	}
}

func TestServicePersistsAcrossRestarts(t *testing.T) {
	dir := t.TempDir()
	conns := conn.NewManager()
	saved := conn.NewStore(t.TempDir())
	first, err := NewService(dir, conns, saved, nil, "test")
	if err != nil {
		t.Fatal(err)
	}
	port := freePort(t)
	st, err := first.Save(Config{Enabled: true, Port: port, Read: true, Write: true,
		Databases: []string{"sales"}, Token: first.Status().Token})
	if err != nil {
		t.Fatal(err)
	}
	first.Stop()

	second, err := NewService(dir, conns, saved, nil, "test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(second.Stop)
	got := second.Status()
	if !got.Enabled || got.Port != port || !got.Write || got.Token != st.Token {
		t.Fatalf("reloaded status = %+v", got)
	}
	if got.Running {
		t.Fatal("a new service is running before Start")
	}
	if err := second.Start(); err != nil {
		t.Fatal(err)
	}
	if code := ping(t, second.Status().URL, got.Token); code != http.StatusOK {
		t.Fatalf("ping: status %d", code)
	}
}
