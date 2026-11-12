// Package gitsync keeps the user's connections, connection folders and
// scratch files in a small Git repository and exchanges them through a
// remote. The repository is a transport, not the live store: the app keeps
// writing its usual files and a sync merges both sides.
//
// The bundle is either plain JSON or an AES-256-GCM envelope protected by a
// master password. The password is never written to disk.
package gitsync

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"dolmen/internal/conn"
	"dolmen/internal/driver"
	"dolmen/internal/folder"
	"dolmen/internal/scratch"
)

const (
	plainFile     = "dolmen.json"
	encryptedFile = "dolmen.enc.json"
	defaultBranch = "main"
	maxPushTries  = 3
)

// Config is the user's git sync settings. It never contains a password.
type Config struct {
	Enabled   bool   `json:"enabled"`
	Remote    string `json:"remote"`
	Branch    string `json:"branch"`
	Encrypted bool   `json:"encrypted"`
}

// Status is what the settings dialog shows without touching the network.
type Status struct {
	Config
	Dir          string `json:"dir"`
	GitAvailable bool   `json:"gitAvailable"`
	RepoExists   bool   `json:"repoExists"`
	LastCommit   string `json:"lastCommit,omitempty"`
	LastSyncAt   int64  `json:"lastSyncAt,omitempty"`
	LastError    string `json:"lastError,omitempty"`
}

// Result reports what one manual sync did.
type Result struct {
	Commit      string `json:"commit,omitempty"`
	Changed     bool   `json:"changed"`
	LastSyncAt  int64  `json:"lastSyncAt"`
	Connections int    `json:"connections"`
	Scratches   int    `json:"scratches"`
}

// Bundle is the synchronised payload. Timestamps are unix milliseconds.
type Bundle struct {
	Version     int             `json:"version"`
	UpdatedAt   int64           `json:"updatedAt"`
	Connections []driver.Config `json:"connections"`
	Folders     []folder.Folder `json:"folders"`
	Scratches   []scratch.Entry `json:"scratches"`
	// Deleted records removals ("conn:<id>", "folder:<id>", "scratch:<id>")
	// so a scratch deleted on one machine does not come back from another.
	Deleted map[string]int64 `json:"deleted,omitempty"`
}

type syncState struct {
	LastSyncAt int64           `json:"lastSyncAt,omitempty"`
	LastCommit string          `json:"lastCommit,omitempty"`
	LastError  string          `json:"lastError,omitempty"`
	Items      map[string]bool `json:"items,omitempty"`
}

// Service owns the sync repository and the bundle inside it.
type Service struct {
	dir        string
	configPath string
	statePath  string
	conns      *conn.Store
	folders    *folder.Store
	scratches  *scratch.Store
	mu         sync.Mutex
}

func NewService(dataDir string, conns *conn.Store, folders *folder.Store, scratches *scratch.Store) *Service {
	return &Service{
		dir:        filepath.Join(dataDir, "sync"),
		configPath: filepath.Join(dataDir, "sync.json"),
		statePath:  filepath.Join(dataDir, "sync-state.json"),
		conns:      conns,
		folders:    folders,
		scratches:  scratches,
	}
}

// Config returns the saved sync settings (defaults when unset).
func (s *Service) Config() (Config, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadConfig()
}

// SaveConfig validates and writes the sync settings.
func (s *Service) SaveConfig(c Config) (Config, error) {
	c = normalize(c)
	if err := validate(c); err != nil {
		return Config{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return Config{}, err
	}
	return c, atomicWrite(s.configPath, b)
}

// Status reports the settings plus the last sync result.
func (s *Service) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	cfg, _ := s.loadConfig()
	st := s.loadState()
	status := Status{
		Config:       cfg,
		Dir:          s.dir,
		GitAvailable: hasGit(),
		RepoExists:   exists(filepath.Join(s.dir, ".git")),
		LastCommit:   st.LastCommit,
		LastSyncAt:   st.LastSyncAt,
		LastError:    st.LastError,
	}
	if status.GitAvailable && status.RepoExists {
		if out, err := s.git("rev-parse", "--short", "HEAD"); err == nil {
			status.LastCommit = strings.TrimSpace(out)
		}
	}
	return status
}

func (s *Service) loadConfig() (Config, error) {
	var c Config
	b, err := os.ReadFile(s.configPath)
	if errors.Is(err, os.ErrNotExist) {
		return normalize(Config{}), nil
	}
	if err != nil {
		return Config{}, err
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return Config{}, fmt.Errorf("reading %s: %w", s.configPath, err)
	}
	return normalize(c), nil
}

func normalize(c Config) Config {
	c.Remote = strings.TrimSpace(c.Remote)
	c.Branch = strings.TrimSpace(c.Branch)
	if c.Branch == "" {
		c.Branch = defaultBranch
	}
	return c
}

func validate(c Config) error {
	if !validBranch(c.Branch) {
		return fmt.Errorf("invalid branch name %q", c.Branch)
	}
	return nil
}

func validBranch(b string) bool {
	if b == "" || len(b) > 200 || strings.HasPrefix(b, "/") || strings.HasSuffix(b, "/") ||
		strings.Contains(b, "..") || strings.Contains(b, "//") || strings.HasSuffix(b, ".lock") {
		return false
	}
	for _, r := range b {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '.', r == '_', r == '-', r == '/':
		default:
			return false
		}
	}
	return true
}

// Sync pulls the remote bundle, merges it with the local state, pushes the
// result and applies it locally. password is only needed when the bundle is
// encrypted (or when the remote still is and the local mode just changed).
func (s *Service) Sync(password string) (res Result, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	st := s.loadState()
	defer func() {
		if err == nil {
			return
		}
		st.LastError = err.Error()
		_ = s.saveState(st)
	}()

	cfg, err := s.loadConfig()
	if err != nil {
		return res, err
	}
	if !cfg.Enabled {
		return res, errors.New("git sync is turned off")
	}
	if !hasGit() {
		return res, errors.New("git is not installed or not on PATH")
	}
	if err = s.ensureRepo(cfg); err != nil {
		return res, err
	}

	local, err := s.localBundle()
	if err != nil {
		return res, err
	}
	// A record present at the end of the previous sync but gone now was
	// deleted locally: remember it so the other machines delete it too.
	local.Deleted = mergeDeleted(local.Deleted, missingItems(st.Items, local))

	merged := local
	if cfg.Remote != "" {
		remote, ferr := s.fetchRemote(cfg, password)
		if ferr != nil {
			return res, ferr
		}
		if remote != nil {
			merged = mergeBundles(merged, *remote)
		}
	}

	commit, changed, err := s.commitAndPush(cfg, merged, password)
	if err != nil {
		return res, err
	}
	// Pick up anything typed or created while the network round-trip ran, so
	// applying the merge never drops a scratch the user just made. Those
	// changes go out with the next sync.
	if fresh, ferr := s.localBundle(); ferr == nil {
		merged = mergeBundles(fresh, merged)
	}
	if err := s.apply(merged); err != nil {
		return res, err
	}
	at := time.Now().UnixMilli()
	st.LastSyncAt = at
	st.LastCommit = commit
	st.LastError = ""
	st.Items = itemSet(merged)
	if err := s.saveState(st); err != nil {
		return res, err
	}
	return Result{
		Commit: commit, Changed: changed, LastSyncAt: at,
		Connections: len(merged.Connections), Scratches: len(merged.Scratches),
	}, nil
}

// localBundle snapshots the live stores.
func (s *Service) localBundle() (Bundle, error) {
	conns, err := s.conns.List()
	if err != nil {
		return Bundle{}, err
	}
	folders, err := s.folders.List()
	if err != nil {
		return Bundle{}, err
	}
	scratches, err := s.scratches.Snapshot()
	if err != nil {
		return Bundle{}, err
	}
	return Bundle{
		Version: 1, UpdatedAt: time.Now().UnixMilli(),
		Connections: conns, Folders: folders, Scratches: scratches,
	}, nil
}

// apply writes the merged bundle back to the live stores.
func (s *Service) apply(b Bundle) error {
	if err := s.conns.Replace(b.Connections); err != nil {
		return err
	}
	if err := s.folders.Replace(b.Folders); err != nil {
		return err
	}
	return s.scratches.Replace(b.Scratches)
}

// ---------- git ----------

func hasGit() bool {
	_, err := exec.LookPath("git")
	return err == nil
}

func (s *Service) git(args ...string) (string, error) {
	cmd := exec.Command("git", append([]string{"-C", s.dir}, args...)...)
	// A desktop window cannot answer a password prompt on the terminal; rely
	// on the user's credential helper or SSH agent instead.
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = err.Error()
		}
		return string(out), fmt.Errorf("git %s: %s", strings.Join(args, " "), msg)
	}
	return string(out), nil
}

func (s *Service) ensureRepo(cfg Config) error {
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	if !exists(filepath.Join(s.dir, ".git")) {
		if _, err := s.git("init", "-q"); err != nil {
			return err
		}
	}
	// Keep the checked-out branch in line with the setting, including right
	// after git init (whose default branch depends on the user's config).
	if _, err := s.git("symbolic-ref", "HEAD", "refs/heads/"+cfg.Branch); err != nil {
		return err
	}
	// Commits need an identity; keep the user's when one is configured.
	if _, err := s.git("config", "user.name"); err != nil {
		if _, err := s.git("config", "user.name", "Dolmen"); err != nil {
			return err
		}
	}
	if _, err := s.git("config", "user.email"); err != nil {
		if _, err := s.git("config", "user.email", "dolmen@localhost"); err != nil {
			return err
		}
	}
	url, err := s.git("remote", "get-url", "origin")
	switch {
	case cfg.Remote == "" && err == nil:
		if _, err := s.git("remote", "remove", "origin"); err != nil {
			return err
		}
	case cfg.Remote != "" && err != nil:
		if _, err := s.git("remote", "add", "origin", cfg.Remote); err != nil {
			return err
		}
	case cfg.Remote != "" && strings.TrimSpace(url) != cfg.Remote:
		if _, err := s.git("remote", "set-url", "origin", cfg.Remote); err != nil {
			return err
		}
	}
	return nil
}

// fetchRemote leaves the repository at the remote branch and returns the
// bundle it carries (nil when the branch or the bundle does not exist yet).
func (s *Service) fetchRemote(cfg Config, password string) (*Bundle, error) {
	out, err := s.git("ls-remote", "--heads", "origin", cfg.Branch)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(out) == "" {
		return nil, nil // first push to this branch
	}
	if _, err := s.git("fetch", "--prune", "origin", cfg.Branch); err != nil {
		return nil, err
	}
	if _, err := s.git("reset", "--hard", "FETCH_HEAD"); err != nil {
		return nil, err
	}
	return s.readBundle(password)
}

// commitAndPush writes the merged bundle, commits it and pushes. When the
// remote moved in the meantime it pulls once more, merges and retries.
func (s *Service) commitAndPush(cfg Config, merged Bundle, password string) (string, bool, error) {
	changedAny := false
	for attempt := 0; attempt < maxPushTries; attempt++ {
		if err := s.writeBundle(cfg, merged, password); err != nil {
			return "", changedAny, err
		}
		if _, err := s.git("add", "-A"); err != nil {
			return "", changedAny, err
		}
		st, err := s.git("status", "--porcelain")
		if err != nil {
			return "", changedAny, err
		}
		changed := strings.TrimSpace(st) != ""
		if changed {
			msg := "sync: " + time.Now().UTC().Format("2006-01-02 15:04:05")
			if _, err := s.git("commit", "-q", "-m", msg); err != nil {
				return "", changedAny, err
			}
			changedAny = true
		}
		commit := s.head()
		if cfg.Remote == "" {
			return commit, changedAny, nil
		}
		if _, err := s.git("push", "-q", "origin", "HEAD:"+cfg.Branch); err != nil {
			if attempt == maxPushTries-1 || !rejected(err) {
				return "", changedAny, err
			}
			remote, ferr := s.fetchRemote(cfg, password)
			if ferr != nil {
				return "", changedAny, ferr
			}
			if remote != nil {
				merged = mergeBundles(merged, *remote)
			}
			continue
		}
		return commit, changedAny, nil
	}
	return "", changedAny, errors.New("the remote kept moving during the sync; try again")
}

func rejected(err error) bool {
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "rejected") || strings.Contains(msg, "fetch first") ||
		strings.Contains(msg, "non-fast-forward") || strings.Contains(msg, "failed to push")
}

func (s *Service) head() string {
	if out, err := s.git("rev-parse", "--short", "HEAD"); err == nil {
		return strings.TrimSpace(out)
	}
	return ""
}

// ---------- bundle files ----------

func (s *Service) readBundle(password string) (*Bundle, error) {
	plainPath := filepath.Join(s.dir, plainFile)
	encPath := filepath.Join(s.dir, encryptedFile)
	plain, plainErr := os.ReadFile(plainPath)
	enc, encErr := os.ReadFile(encPath)
	hasPlain, hasEnc := plainErr == nil, encErr == nil
	if plainErr != nil && !errors.Is(plainErr, os.ErrNotExist) {
		return nil, plainErr
	}
	if encErr != nil && !errors.Is(encErr, os.ErrNotExist) {
		return nil, encErr
	}
	switch {
	case hasPlain && hasEnc:
		return nil, fmt.Errorf("the sync repository has both %s and %s; delete one", plainFile, encryptedFile)
	case hasEnc:
		if password == "" {
			return nil, errors.New("the sync repository is encrypted: a master password is required")
		}
		var err error
		plain, err = open(enc, password)
		if err != nil {
			return nil, err
		}
	case hasPlain:
		// Already decrypted.
	default:
		return nil, nil
	}
	var b Bundle
	if err := json.Unmarshal(plain, &b); err != nil {
		return nil, fmt.Errorf("reading the sync bundle: %w", err)
	}
	if b.Connections == nil {
		b.Connections = []driver.Config{}
	}
	if b.Folders == nil {
		b.Folders = []folder.Folder{}
	}
	b.ScratchList()
	return &b, nil
}

func (s *Service) writeBundle(cfg Config, b Bundle, password string) error {
	if b.Connections == nil {
		b.Connections = []driver.Config{}
	}
	if b.Folders == nil {
		b.Folders = []folder.Folder{}
	}
	b.ScratchList()
	b.Version = 1
	b.UpdatedAt = time.Now().UnixMilli()
	plain, err := json.MarshalIndent(b, "", "  ")
	if err != nil {
		return err
	}
	plainPath := filepath.Join(s.dir, plainFile)
	encPath := filepath.Join(s.dir, encryptedFile)
	if cfg.Encrypted {
		if password == "" {
			return errors.New("a master password is required to encrypt the sync repository")
		}
		sealed, err := seal(plain, password)
		if err != nil {
			return err
		}
		if err := atomicWrite(encPath, sealed); err != nil {
			return err
		}
		if err := os.Remove(plainPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	if err := atomicWrite(plainPath, plain); err != nil {
		return err
	}
	if err := os.Remove(encPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// ScratchList returns the scratches, initialising the slice so JSON gets [].
func (b *Bundle) ScratchList() []scratch.Entry {
	if b.Scratches == nil {
		b.Scratches = []scratch.Entry{}
	}
	return b.Scratches
}

// ---------- merge ----------

func mergeBundles(a, b Bundle) Bundle {
	out := Bundle{
		Version:   1,
		UpdatedAt: max(a.UpdatedAt, b.UpdatedAt),
		Deleted:   mergeDeleted(a.Deleted, b.Deleted),
	}
	out.Connections = mergeItems(a.Connections, b.Connections,
		func(c driver.Config) string { return "conn:" + c.ID },
		func(c driver.Config) int64 { return c.UpdatedAt }, out.Deleted)
	out.Folders = mergeItems(a.Folders, b.Folders,
		func(f folder.Folder) string { return "folder:" + f.ID },
		func(f folder.Folder) int64 { return f.UpdatedAt }, out.Deleted)
	out.Scratches = mergeScratches(a.ScratchList(), b.ScratchList(), out.Deleted)
	return out
}

func mergeScratches(a, b []scratch.Entry, deleted map[string]int64) []scratch.Entry {
	return mergeItems(a, b,
		func(e scratch.Entry) string { return "scratch:" + e.ID },
		func(e scratch.Entry) int64 { return e.UpdatedAt }, deleted)
}

func mergeItems[T any](a, b []T, key func(T) string, updated func(T) int64, deleted map[string]int64) []T {
	out := make([]T, 0, len(a)+len(b))
	at := make(map[string]int, len(a)+len(b))
	for _, list := range [][]T{a, b} {
		for _, item := range list {
			k := key(item)
			if k == "" {
				continue
			}
			if ts, gone := deleted[k]; gone && ts >= updated(item) {
				continue
			}
			if i, ok := at[k]; ok {
				if updated(item) > updated(out[i]) {
					out[i] = item
				}
				continue
			}
			at[k] = len(out)
			out = append(out, item)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return key(out[i]) < key(out[j]) })
	return out
}

func mergeDeleted(a, b map[string]int64) map[string]int64 {
	out := make(map[string]int64, len(a)+len(b))
	for k, v := range a {
		out[k] = v
	}
	for k, v := range b {
		if v > out[k] {
			out[k] = v
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// missingItems lists records that were known at the previous sync but are
// no longer in the local bundle.
func missingItems(known map[string]bool, local Bundle) map[string]int64 {
	if len(known) == 0 {
		return nil
	}
	now := time.Now().UnixMilli()
	present := itemSet(local)
	out := map[string]int64{}
	for k := range known {
		if !present[k] {
			out[k] = now
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func itemSet(b Bundle) map[string]bool {
	out := make(map[string]bool, len(b.Connections)+len(b.Folders)+len(b.ScratchList()))
	for _, c := range b.Connections {
		out["conn:"+c.ID] = true
	}
	for _, f := range b.Folders {
		out["folder:"+f.ID] = true
	}
	for _, s := range b.ScratchList() {
		out["scratch:"+s.ID] = true
	}
	return out
}

// ---------- local state ----------

func (s *Service) loadState() syncState {
	var st syncState
	if b, err := os.ReadFile(s.statePath); err == nil {
		_ = json.Unmarshal(b, &st)
	}
	return st
}

func (s *Service) saveState(st syncState) error {
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(s.statePath, b)
}

func atomicWrite(path string, b []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func max(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
