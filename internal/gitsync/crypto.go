package gitsync

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
)

// Envelope is the on-disk form of an encrypted bundle. It carries everything
// needed to derive the key again, except the master password itself.
type Envelope struct {
	Version    int    `json:"version"`
	KDF        string `json:"kdf"`
	Iterations int    `json:"iterations"`
	Salt       string `json:"salt"`
	Nonce      string `json:"nonce"`
	Data       string `json:"data"`
}

const (
	envelopeVersion = 1
	kdfName         = "pbkdf2-sha256"
	// OWASP's recommendation for PBKDF2-HMAC-SHA256 in 2023; enough for a
	// desktop app without making a manual sync feel slow.
	kdfIterations = 210_000
	keyLength     = 32
)

var ErrPassword = errors.New("wrong master password, or the encrypted bundle is corrupted")

// seal encrypts the bundle with AES-256-GCM under a key derived from the
// master password.
func seal(plain []byte, password string) ([]byte, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	key, err := pbkdf2.Key(sha256.New, password, salt, kdfIterations, keyLength)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	sealed := gcm.Seal(nil, nonce, plain, nil)
	env := Envelope{
		Version:    envelopeVersion,
		KDF:        kdfName,
		Iterations: kdfIterations,
		Salt:       base64.StdEncoding.EncodeToString(salt),
		Nonce:      base64.StdEncoding.EncodeToString(nonce),
		Data:       base64.StdEncoding.EncodeToString(sealed),
	}
	return json.MarshalIndent(env, "", "  ")
}

// open decrypts a bundle written by seal.
func open(b []byte, password string) ([]byte, error) {
	var env Envelope
	if err := json.Unmarshal(b, &env); err != nil {
		return nil, fmt.Errorf("reading the encrypted bundle: %w", err)
	}
	if env.Version != envelopeVersion || env.KDF != kdfName || env.Iterations < 1 {
		return nil, errors.New("unsupported encrypted bundle")
	}
	salt, err := base64.StdEncoding.DecodeString(env.Salt)
	if err != nil {
		return nil, ErrPassword
	}
	nonce, err := base64.StdEncoding.DecodeString(env.Nonce)
	if err != nil {
		return nil, ErrPassword
	}
	data, err := base64.StdEncoding.DecodeString(env.Data)
	if err != nil {
		return nil, ErrPassword
	}
	key, err := pbkdf2.Key(sha256.New, password, salt, env.Iterations, keyLength)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plain, err := gcm.Open(nil, nonce, data, nil)
	if err != nil {
		return nil, ErrPassword
	}
	return plain, nil
}
