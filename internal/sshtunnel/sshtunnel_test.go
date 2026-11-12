package sshtunnel

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// echoServer accepts connections and sends back what it receives.
func echoServer(t *testing.T) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()
	return ln
}

type directTCPIP struct {
	DestAddr   string
	DestPort   uint32
	OriginAddr string
	OriginPort uint32
}

// sshServer runs a minimal SSH server that forwards direct-tcpip channels.
func sshServer(t *testing.T, password string, authorized ssh.PublicKey) string {
	t.Helper()
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	hostKey, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &ssh.ServerConfig{
		PasswordCallback: func(_ ssh.ConnMetadata, pass []byte) (*ssh.Permissions, error) {
			if string(pass) == password {
				return nil, nil
			}
			return nil, errors.New("wrong password")
		},
	}
	if authorized != nil {
		cfg.PublicKeyCallback = func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if string(key.Marshal()) == string(authorized.Marshal()) {
				return nil, nil
			}
			return nil, errors.New("unknown key")
		}
	}
	cfg.AddHostKey(hostKey)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go serveSSH(conn, cfg)
		}
	}()
	return ln.Addr().String()
}

func serveSSH(conn net.Conn, cfg *ssh.ServerConfig) {
	_, chans, reqs, err := ssh.NewServerConn(conn, cfg)
	if err != nil {
		return
	}
	go ssh.DiscardRequests(reqs)
	for ch := range chans {
		if ch.ChannelType() != "direct-tcpip" {
			_ = ch.Reject(ssh.UnknownChannelType, "unsupported")
			continue
		}
		var req directTCPIP
		if err := ssh.Unmarshal(ch.ExtraData(), &req); err != nil {
			_ = ch.Reject(ssh.ConnectionFailed, "bad request")
			continue
		}
		channel, requests, err := ch.Accept()
		if err != nil {
			continue
		}
		go ssh.DiscardRequests(requests)
		remote, err := net.Dial("tcp", net.JoinHostPort(req.DestAddr, strconv.Itoa(int(req.DestPort))))
		if err != nil {
			channel.Close()
			continue
		}
		go func() { _, _ = io.Copy(remote, channel); remote.Close() }()
		go func() { _, _ = io.Copy(channel, remote); channel.Close() }()
	}
}

func connect(t *testing.T, sshAddr string, cfg Config, target string) *Tunnel {
	t.Helper()
	host, port, err := net.SplitHostPort(sshAddr)
	if err != nil {
		t.Fatal(err)
	}
	n, _ := strconv.Atoi(port)
	cfg.Host, cfg.Port = host, n
	cfg.InsecureHostKey = true
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tun, err := Open(ctx, cfg, target)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { tun.Close() })
	return tun
}

func roundTrip(t *testing.T, addr string) {
	t.Helper()
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, 5)
	if _, err := io.ReadFull(conn, got); err != nil {
		t.Fatal(err)
	}
	if string(got) != "hello" {
		t.Errorf("echoed %q", got)
	}
}

func TestTunnelWithPassword(t *testing.T) {
	echo := echoServer(t)
	sshAddr := sshServer(t, "secret", nil)
	tun := connect(t, sshAddr, Config{User: "dolmen", Method: "password", Password: "secret"}, echo.Addr().String())
	if tun.Host() != "127.0.0.1" || tun.Port() == 0 {
		t.Errorf("tunnel address = %s:%d", tun.Host(), tun.Port())
	}
	roundTrip(t, tun.Addr())
}

func TestTunnelWithKey(t *testing.T) {
	echo := echoServer(t)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatal(err)
	}
	sshAddr := sshServer(t, "", signer.PublicKey())

	path := filepath.Join(t.TempDir(), "id_rsa")
	pemKey := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	if err := os.WriteFile(path, pemKey, 0o600); err != nil {
		t.Fatal(err)
	}
	tun := connect(t, sshAddr, Config{User: "dolmen", Method: "key", KeyPath: path}, echo.Addr().String())
	roundTrip(t, tun.Addr())
}

func TestTunnelRejectsWrongPassword(t *testing.T) {
	echo := echoServer(t)
	sshAddr := sshServer(t, "secret", nil)
	host, port, _ := net.SplitHostPort(sshAddr)
	n, _ := strconv.Atoi(port)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := Open(ctx, Config{
		Host: host, Port: n, User: "dolmen", Method: "password", Password: "nope", InsecureHostKey: true,
	}, echo.Addr().String())
	if err == nil {
		t.Fatal("connecting with the wrong password succeeded")
	}
}

func TestTunnelRequiresHostAndUser(t *testing.T) {
	if _, err := Open(context.Background(), Config{User: "dolmen"}, "localhost:5432"); err == nil {
		t.Error("missing host accepted")
	}
	if _, err := Open(context.Background(), Config{Host: "localhost"}, "localhost:5432"); err == nil {
		t.Error("missing user accepted")
	}
}
