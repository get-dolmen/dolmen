// Package sshtunnel forwards a local TCP port to a database server through
// an SSH jump host, so a connection can reach servers that are only visible
// from the bastion.
package sshtunnel

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
	"golang.org/x/crypto/ssh/knownhosts"
)

// Config is a saved SSH tunnel definition. Passwords and passphrases are
// stored like database passwords.
type Config struct {
	Enabled bool   `json:"enabled"`
	Host    string `json:"host,omitempty"`
	Port    int    `json:"port,omitempty"`
	User    string `json:"user,omitempty"`
	// Method is "password", "key" or "agent"; empty means password.
	Method     string `json:"method,omitempty"`
	Password   string `json:"password,omitempty"`
	KeyPath    string `json:"keyPath,omitempty"`
	Passphrase string `json:"passphrase,omitempty"`
	// InsecureHostKey skips checking the server against ~/.ssh/known_hosts.
	InsecureHostKey bool `json:"insecureHostKey,omitempty"`
}

// Tunnel is a local listener forwarding every connection through SSH.
type Tunnel struct {
	listener net.Listener
	client   *ssh.Client
	target   string
	agent    io.Closer

	once sync.Once
	err  error
}

// Open connects to the SSH server and starts a local listener for target
// ("host:port" as seen from the SSH server).
func Open(ctx context.Context, cfg Config, target string) (*Tunnel, error) {
	if strings.TrimSpace(cfg.Host) == "" {
		return nil, errors.New("SSH host is required")
	}
	if strings.TrimSpace(cfg.User) == "" {
		return nil, errors.New("SSH user is required")
	}
	port := cfg.Port
	if port == 0 {
		port = 22
	}
	methods, closer, err := authMethods(cfg)
	if err != nil {
		return nil, err
	}
	hostKey, err := hostKeyCallback(cfg)
	if err != nil {
		closeIfSet(closer)
		return nil, err
	}
	addr := net.JoinHostPort(cfg.Host, strconv.Itoa(port))
	dialer := net.Dialer{Timeout: 15 * time.Second}
	netConn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		closeIfSet(closer)
		return nil, fmt.Errorf("could not reach the SSH server: %w", err)
	}
	sshConn, chans, reqs, err := ssh.NewClientConn(netConn, addr, &ssh.ClientConfig{
		User:            cfg.User,
		Auth:            methods,
		HostKeyCallback: hostKey,
		Timeout:         15 * time.Second,
	})
	if err != nil {
		netConn.Close()
		closeIfSet(closer)
		return nil, fmt.Errorf("SSH handshake failed: %w", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		sshConn.Close()
		closeIfSet(closer)
		return nil, err
	}
	t := &Tunnel{listener: listener, client: ssh.NewClient(sshConn, chans, reqs), target: target, agent: closer}
	go t.serve()
	return t, nil
}

// Host and Port are the local address the database DSN should use.
func (t *Tunnel) Host() string { return "127.0.0.1" }

func (t *Tunnel) Port() int { return t.listener.Addr().(*net.TCPAddr).Port }

// Addr returns the local "host:port".
func (t *Tunnel) Addr() string { return t.listener.Addr().String() }

// Close stops accepting connections and drops the SSH session.
func (t *Tunnel) Close() error {
	t.once.Do(func() {
		t.err = t.listener.Close()
		if err := t.client.Close(); err != nil && t.err == nil {
			t.err = err
		}
		closeIfSet(t.agent)
	})
	return t.err
}

func (t *Tunnel) serve() {
	for {
		local, err := t.listener.Accept()
		if err != nil {
			return
		}
		go t.forward(local)
	}
}

func (t *Tunnel) forward(local net.Conn) {
	defer local.Close()
	remote, err := t.client.Dial("tcp", t.target)
	if err != nil {
		return
	}
	defer remote.Close()
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(remote, local); done <- struct{}{} }()
	go func() { _, _ = io.Copy(local, remote); done <- struct{}{} }()
	<-done
}

func authMethods(cfg Config) ([]ssh.AuthMethod, io.Closer, error) {
	switch strings.ToLower(cfg.Method) {
	case "", "password":
		if cfg.Password == "" {
			return nil, nil, errors.New("an SSH password is required")
		}
		password := cfg.Password
		// Some servers only offer keyboard-interactive.
		keyboard := ssh.KeyboardInteractive(func(_, _ string, questions []string, _ []bool) ([]string, error) {
			answers := make([]string, len(questions))
			for i := range answers {
				answers[i] = password
			}
			return answers, nil
		})
		return []ssh.AuthMethod{ssh.Password(password), keyboard}, nil, nil
	case "key":
		path := expandHome(cfg.KeyPath)
		if path == "" {
			return nil, nil, errors.New("an SSH private key is required")
		}
		key, err := os.ReadFile(path)
		if err != nil {
			return nil, nil, fmt.Errorf("could not read the SSH key: %w", err)
		}
		var signer ssh.Signer
		if cfg.Passphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase(key, []byte(cfg.Passphrase))
		} else {
			signer, err = ssh.ParsePrivateKey(key)
		}
		if err != nil {
			return nil, nil, fmt.Errorf("could not use the SSH key: %w", err)
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signer)}, nil, nil
	case "agent":
		sock := os.Getenv("SSH_AUTH_SOCK")
		if sock == "" {
			return nil, nil, errors.New("SSH_AUTH_SOCK is not set; start ssh-agent or choose another authentication method")
		}
		conn, err := net.Dial("unix", sock)
		if err != nil {
			return nil, nil, fmt.Errorf("could not reach the SSH agent: %w", err)
		}
		signers, err := agent.NewClient(conn).Signers()
		if err != nil {
			conn.Close()
			return nil, nil, fmt.Errorf("could not read the SSH agent keys: %w", err)
		}
		if len(signers) == 0 {
			conn.Close()
			return nil, nil, errors.New("the SSH agent has no keys")
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signers...)}, conn, nil
	}
	return nil, nil, fmt.Errorf("unknown SSH authentication method %q", cfg.Method)
}

// hostKeyCallback verifies the server against ~/.ssh/known_hosts when that
// file exists. A missing file means there is nothing to compare with.
func hostKeyCallback(cfg Config) (ssh.HostKeyCallback, error) {
	if cfg.InsecureHostKey {
		return ssh.InsecureIgnoreHostKey(), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ssh.InsecureIgnoreHostKey(), nil
	}
	path := filepath.Join(home, ".ssh", "known_hosts")
	if _, err := os.Stat(path); err != nil {
		return ssh.InsecureIgnoreHostKey(), nil
	}
	return knownhosts.New(path)
}

func expandHome(path string) string {
	path = strings.TrimSpace(path)
	if path == "~" || strings.HasPrefix(path, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, strings.TrimPrefix(path, "~"))
		}
	}
	return path
}

func closeIfSet(c io.Closer) {
	if c != nil {
		_ = c.Close()
	}
}
