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
func Open(ctx context.Context, config Config, target string) (*Tunnel, error) {
	if strings.TrimSpace(config.Host) == "" {
		return nil, errors.New("SSH host is required")
	}
	if strings.TrimSpace(config.User) == "" {
		return nil, errors.New("SSH user is required")
	}
	port := config.Port
	if port == 0 {
		port = 22
	}
	methods, closer, err := authMethods(config)
	if err != nil {
		return nil, err
	}
	hostKey, err := hostKeyCallback(config)
	if err != nil {
		closeIfSet(closer)
		return nil, err
	}
	addr := net.JoinHostPort(config.Host, strconv.Itoa(port))
	dialer := net.Dialer{Timeout: 15 * time.Second}
	networkConnection, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		closeIfSet(closer)
		return nil, fmt.Errorf("could not reach the SSH server: %w", err)
	}
	sshConnection, channels, requests, err := ssh.NewClientConn(networkConnection, addr, &ssh.ClientConfig{
		User:            config.User,
		Auth:            methods,
		HostKeyCallback: hostKey,
		Timeout:         15 * time.Second,
	})
	if err != nil {
		networkConnection.Close()
		closeIfSet(closer)
		return nil, fmt.Errorf("SSH handshake failed: %w", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		sshConnection.Close()
		closeIfSet(closer)
		return nil, err
	}
	tunnel := &Tunnel{listener: listener, client: ssh.NewClient(sshConnection, channels, requests), target: target, agent: closer}
	go tunnel.serve()
	return tunnel, nil
}

// Host and Port are the local address the database DSN should use.
func (tunnel *Tunnel) Host() string { return "127.0.0.1" }

func (tunnel *Tunnel) Port() int { return tunnel.listener.Addr().(*net.TCPAddr).Port }

// Addr returns the local "host:port".
func (tunnel *Tunnel) Addr() string { return tunnel.listener.Addr().String() }

// Close stops accepting connections and drops the SSH session.
func (tunnel *Tunnel) Close() error {
	tunnel.once.Do(func() {
		tunnel.err = tunnel.listener.Close()
		if err := tunnel.client.Close(); err != nil && tunnel.err == nil {
			tunnel.err = err
		}
		closeIfSet(tunnel.agent)
	})
	return tunnel.err
}

func (tunnel *Tunnel) serve() {
	for {
		local, err := tunnel.listener.Accept()
		if err != nil {
			return
		}
		go tunnel.forward(local)
	}
}

func (tunnel *Tunnel) forward(local net.Conn) {
	defer local.Close()
	remote, err := tunnel.client.Dial("tcp", tunnel.target)
	if err != nil {
		return
	}
	defer remote.Close()
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(remote, local); done <- struct{}{} }()
	go func() { _, _ = io.Copy(local, remote); done <- struct{}{} }()
	<-done
}

func authMethods(config Config) ([]ssh.AuthMethod, io.Closer, error) {
	switch strings.ToLower(config.Method) {
	case "", "password":
		if config.Password == "" {
			return nil, nil, errors.New("an SSH password is required")
		}
		password := config.Password
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
		path := expandHome(config.KeyPath)
		if path == "" {
			return nil, nil, errors.New("an SSH private key is required")
		}
		key, err := os.ReadFile(path)
		if err != nil {
			return nil, nil, fmt.Errorf("could not read the SSH key: %w", err)
		}
		var signer ssh.Signer
		if config.Passphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase(key, []byte(config.Passphrase))
		} else {
			signer, err = ssh.ParsePrivateKey(key)
		}
		if err != nil {
			return nil, nil, fmt.Errorf("could not use the SSH key: %w", err)
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signer)}, nil, nil
	case "agent":
		socket := os.Getenv("SSH_AUTH_SOCK")
		if socket == "" {
			return nil, nil, errors.New("SSH_AUTH_SOCK is not set; start ssh-agent or choose another authentication method")
		}
		connection, err := net.Dial("unix", socket)
		if err != nil {
			return nil, nil, fmt.Errorf("could not reach the SSH agent: %w", err)
		}
		signers, err := agent.NewClient(connection).Signers()
		if err != nil {
			connection.Close()
			return nil, nil, fmt.Errorf("could not read the SSH agent keys: %w", err)
		}
		if len(signers) == 0 {
			connection.Close()
			return nil, nil, errors.New("the SSH agent has no keys")
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signers...)}, connection, nil
	}
	return nil, nil, fmt.Errorf("unknown SSH authentication method %q", config.Method)
}

// hostKeyCallback verifies the server against ~/.ssh/known_hosts when that
// file exists. A missing file means there is nothing to compare with.
func hostKeyCallback(config Config) (ssh.HostKeyCallback, error) {
	if config.InsecureHostKey {
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

// expandHome turns a key path as typed or pasted into one the OS can open.
// It drops the quotes Windows Explorer adds with "Copy as path", expands
// %VAR% variables, and resolves a leading ~ followed by either separator.
func expandHome(path string) string {
	path = strings.TrimSpace(path)
	if len(path) >= 2 && (path[0] == '"' || path[0] == '\'') && path[len(path)-1] == path[0] {
		path = strings.TrimSpace(path[1 : len(path)-1])
	}
	if path == "" {
		return ""
	}
	path = expandPercentVars(path)
	if path == "~" || strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, path[1:])
		}
	}
	return filepath.Clean(path)
}

// expandPercentVars replaces %NAME% with the variable's value, as cmd.exe
// does. Unset names and lone % signs are left as they are.
func expandPercentVars(text string) string {
	var builder strings.Builder
	for {
		start := strings.IndexByte(text, '%')
		if start < 0 {
			break
		}
		end := strings.IndexByte(text[start+1:], '%')
		if end <= 0 {
			break
		}
		value := os.Getenv(text[start+1 : start+1+end])
		if value == "" {
			builder.WriteString(text[:start+1])
			text = text[start+1:]
			continue
		}
		builder.WriteString(text[:start])
		builder.WriteString(value)
		text = text[start+2+end:]
	}
	builder.WriteString(text)
	return builder.String()
}

func closeIfSet(closer io.Closer) {
	if closer != nil {
		_ = closer.Close()
	}
}
