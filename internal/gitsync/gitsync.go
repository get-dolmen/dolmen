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

	"dolmen/internal/atomicfile"
	"dolmen/internal/conn"
	"dolmen/internal/driver"
	"dolmen/internal/folder"
	"dolmen/internal/jsonfile"
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
	dir         string
	configPath  string
	statePath   string
	connections *conn.Store
	folders     *folder.Store
	scratches   *scratch.Store
	mu          sync.Mutex
}

func NewService(dataDir string, connections *conn.Store, folders *folder.Store, scratches *scratch.Store) *Service {
	return &Service{
		dir:         filepath.Join(dataDir, "sync"),
		configPath:  filepath.Join(dataDir, "sync.json"),
		statePath:   filepath.Join(dataDir, "sync-state.json"),
		connections: connections,
		folders:     folders,
		scratches:   scratches,
	}
}

// Config returns the saved sync settings (defaults when unset).
func (s *Service) Config() (Config, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.loadConfig()
}

// SaveConfig validates and writes the sync settings.
func (s *Service) SaveConfig(config Config) (Config, error) {
	config = normalize(config)
	if err := validate(config); err != nil {
		return Config{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return config, jsonfile.Write(s.configPath, config, 0o600)
}

// Status reports the settings plus the last sync result.
func (s *Service) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	config, _ := s.loadConfig()
	state := s.loadState()
	status := Status{
		Config:       config,
		Dir:          s.dir,
		GitAvailable: hasGit(),
		RepoExists:   exists(filepath.Join(s.dir, ".git")),
		LastCommit:   state.LastCommit,
		LastSyncAt:   state.LastSyncAt,
		LastError:    state.LastError,
	}
	if status.GitAvailable && status.RepoExists {
		if output, err := s.git("rev-parse", "--short", "HEAD"); err == nil {
			status.LastCommit = strings.TrimSpace(output)
		}
	}
	return status
}

func (s *Service) loadConfig() (Config, error) {
	var config Config
	found, err := jsonfile.Read(s.configPath, &config)
	if err != nil {
		return Config{}, err
	}
	if !found {
		return normalize(Config{}), nil
	}
	return normalize(config), nil
}

func normalize(config Config) Config {
	config.Remote = strings.TrimSpace(config.Remote)
	config.Branch = strings.TrimSpace(config.Branch)
	if config.Branch == "" {
		config.Branch = defaultBranch
	}
	return config
}

func validate(config Config) error {
	if !validBranch(config.Branch) {
		return fmt.Errorf("invalid branch name %q", config.Branch)
	}
	return nil
}

func validBranch(branch string) bool {
	if branch == "" || len(branch) > 200 || strings.HasPrefix(branch, "/") || strings.HasSuffix(branch, "/") ||
		strings.Contains(branch, "..") || strings.Contains(branch, "//") || strings.HasSuffix(branch, ".lock") {
		return false
	}
	for _, character := range branch {
		switch {
		case character >= 'a' && character <= 'z', character >= 'A' && character <= 'Z', character >= '0' && character <= '9':
		case character == '.', character == '_', character == '-', character == '/':
		default:
			return false
		}
	}
	return true
}

// Sync pulls the remote bundle, merges it with the local state, pushes the
// result and applies it locally. password is only needed when the bundle is
// encrypted (or when the remote still is and the local mode just changed).
func (s *Service) Sync(password string) (result Result, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	state := s.loadState()
	defer func() {
		if err == nil {
			return
		}
		state.LastError = err.Error()
		_ = s.saveState(state)
	}()

	config, err := s.loadConfig()
	if err != nil {
		return result, err
	}
	if !config.Enabled {
		return result, errors.New("git sync is turned off")
	}
	if !hasGit() {
		return result, errors.New("git is not installed or not on PATH")
	}
	if err = s.ensureRepo(config); err != nil {
		return result, err
	}

	local, err := s.localBundle()
	if err != nil {
		return result, err
	}
	// A record present at the end of the previous sync but gone now was
	// deleted locally: remember it so the other machines delete it too.
	local.Deleted = mergeDeleted(local.Deleted, missingItems(state.Items, local))

	merged := local
	if config.Remote != "" {
		remote, remoteEncrypted, fetchErr := s.fetchRemote(config, password)
		if fetchErr != nil {
			return result, fetchErr
		}
		if remoteEncrypted && !config.Encrypted {
			return result, errors.New("the remote bundle is encrypted: turn on the master password and enter it")
		}
		if remote != nil {
			merged = mergeBundles(merged, *remote)
		}
	}

	commit, changed, err := s.commitAndPush(config, merged, password)
	if err != nil {
		return result, err
	}
	// Pick up anything typed or created while the network round-trip ran, so
	// applying the merge never drops a scratch the user just made. Those
	// changes go out with the next sync.
	if fresh, fetchErr := s.localBundle(); fetchErr == nil {
		merged = mergeBundles(fresh, merged)
	}
	if err := s.apply(merged); err != nil {
		return result, err
	}
	syncedAt := time.Now().UnixMilli()
	state.LastSyncAt = syncedAt
	state.LastCommit = commit
	state.LastError = ""
	state.Items = itemSet(merged)
	if err := s.saveState(state); err != nil {
		return result, err
	}
	return Result{
		Commit: commit, Changed: changed, LastSyncAt: syncedAt,
		Connections: len(merged.Connections), Scratches: len(merged.Scratches),
	}, nil
}

// localBundle snapshots the live stores.
func (s *Service) localBundle() (Bundle, error) {
	connections, err := s.connections.List()
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
		Connections: connections, Folders: folders, Scratches: scratches,
	}, nil
}

// apply writes the merged bundle back to the live stores.
func (s *Service) apply(bundle Bundle) error {
	if err := s.connections.Replace(bundle.Connections); err != nil {
		return err
	}
	if err := s.folders.Replace(bundle.Folders); err != nil {
		return err
	}
	return s.scratches.Replace(bundle.Scratches)
}

// ---------- git ----------

func hasGit() bool {
	_, err := exec.LookPath("git")
	return err == nil
}

func (s *Service) git(arguments ...string) (string, error) {
	cmd := exec.Command("git", append([]string{"-C", s.dir}, arguments...)...)
	// A desktop window cannot answer a password prompt on the terminal; rely
	// on the user's credential helper or SSH agent instead.
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	output, err := cmd.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return string(output), fmt.Errorf("git %s: %s", strings.Join(arguments, " "), message)
	}
	return string(output), nil
}

func (s *Service) ensureRepo(config Config) error {
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
	if _, err := s.git("symbolic-ref", "HEAD", "refs/heads/"+config.Branch); err != nil {
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
	case config.Remote == "" && err == nil:
		if _, err := s.git("remote", "remove", "origin"); err != nil {
			return err
		}
	case config.Remote != "" && err != nil:
		if _, err := s.git("remote", "add", "origin", config.Remote); err != nil {
			return err
		}
	case config.Remote != "" && strings.TrimSpace(url) != config.Remote:
		if _, err := s.git("remote", "set-url", "origin", config.Remote); err != nil {
			return err
		}
	}
	return nil
}

// fetchRemote leaves the repository at the remote branch and returns the
// bundle it carries (nil when the branch or the bundle does not exist yet).
func (s *Service) fetchRemote(config Config, password string) (*Bundle, bool, error) {
	output, err := s.git("ls-remote", "--heads", "origin", config.Branch)
	if err != nil {
		return nil, false, err
	}
	if strings.TrimSpace(output) == "" {
		return nil, false, nil // first push to this branch
	}
	if _, err := s.git("fetch", "--prune", "origin", config.Branch); err != nil {
		return nil, false, err
	}
	if _, err := s.git("reset", "--hard", "FETCH_HEAD"); err != nil {
		return nil, false, err
	}
	return s.readBundle(password)
}

// commitAndPush writes the merged bundle, commits it and pushes. When the
// remote moved in the meantime it pulls once more, merges and retries.
func (s *Service) commitAndPush(config Config, merged Bundle, password string) (string, bool, error) {
	changedAny := false
	for attempt := 0; attempt < maxPushTries; attempt++ {
		if err := s.writeBundle(config, merged, password); err != nil {
			return "", changedAny, err
		}
		if _, err := s.git("add", "-A"); err != nil {
			return "", changedAny, err
		}
		state, err := s.git("status", "--porcelain")
		if err != nil {
			return "", changedAny, err
		}
		changed := strings.TrimSpace(state) != ""
		if changed {
			message := "sync: " + time.Now().UTC().Format("2006-01-02 15:04:05")
			if _, err := s.git("commit", "-q", "-m", message); err != nil {
				return "", changedAny, err
			}
			changedAny = true
		}
		commit := s.head()
		if config.Remote == "" {
			return commit, changedAny, nil
		}
		if _, err := s.git("push", "-q", "origin", "HEAD:"+config.Branch); err != nil {
			if attempt == maxPushTries-1 || !rejected(err) {
				return "", changedAny, err
			}
			remote, _, fetchErr := s.fetchRemote(config, password)
			if fetchErr != nil {
				return "", changedAny, fetchErr
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
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "rejected") || strings.Contains(message, "fetch first") ||
		strings.Contains(message, "non-fast-forward") || strings.Contains(message, "failed to push")
}

func (s *Service) head() string {
	if output, err := s.git("rev-parse", "--short", "HEAD"); err == nil {
		return strings.TrimSpace(output)
	}
	return ""
}

// ---------- bundle files ----------

// readBundle returns the bundle and whether it was encrypted on disk.
func (s *Service) readBundle(password string) (*Bundle, bool, error) {
	plainPath := filepath.Join(s.dir, plainFile)
	encryptedPath := filepath.Join(s.dir, encryptedFile)
	plainData, plainError := os.ReadFile(plainPath)
	encryptedData, encryptedError := os.ReadFile(encryptedPath)
	hasPlain, hasEnc := plainError == nil, encryptedError == nil
	if plainError != nil && !errors.Is(plainError, os.ErrNotExist) {
		return nil, false, plainError
	}
	if encryptedError != nil && !errors.Is(encryptedError, os.ErrNotExist) {
		return nil, false, encryptedError
	}
	switch {
	case hasPlain && hasEnc:
		return nil, false, fmt.Errorf("the sync repository has both %s and %s; delete one", plainFile, encryptedFile)
	case hasEnc:
		if password == "" {
			return nil, true, errors.New("the sync repository is encrypted: a master password is required")
		}
		var err error
		plainData, err = open(encryptedData, password)
		if err != nil {
			return nil, true, err
		}
	case hasPlain:
		// Already decrypted.
	default:
		return nil, false, nil
	}
	var bundle Bundle
	if err := json.Unmarshal(plainData, &bundle); err != nil {
		return nil, hasEnc, fmt.Errorf("reading the sync bundle: %w", err)
	}
	if bundle.Connections == nil {
		bundle.Connections = []driver.Config{}
	}
	if bundle.Folders == nil {
		bundle.Folders = []folder.Folder{}
	}
	bundle.ScratchList()
	return &bundle, hasEnc, nil
}

func (s *Service) writeBundle(config Config, bundle Bundle, password string) error {
	if bundle.Connections == nil {
		bundle.Connections = []driver.Config{}
	}
	if bundle.Folders == nil {
		bundle.Folders = []folder.Folder{}
	}
	bundle.ScratchList()
	bundle.Version = 1
	bundle.UpdatedAt = time.Now().UnixMilli()
	encoded, err := json.MarshalIndent(bundle, "", "  ")
	if err != nil {
		return err
	}
	plainPath := filepath.Join(s.dir, plainFile)
	encryptedPath := filepath.Join(s.dir, encryptedFile)
	if config.Encrypted {
		if password == "" {
			return errors.New("a master password is required to encrypt the sync repository")
		}
		sealed, err := seal(encoded, password)
		if err != nil {
			return err
		}
		if err := atomicfile.Write(encryptedPath, sealed, 0o600); err != nil {
			return err
		}
		if err := os.Remove(plainPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	if err := atomicfile.Write(plainPath, encoded, 0o600); err != nil {
		return err
	}
	if err := os.Remove(encryptedPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// ScratchList returns the scratches, initialising the slice so JSON gets [].
func (bundle *Bundle) ScratchList() []scratch.Entry {
	if bundle.Scratches == nil {
		bundle.Scratches = []scratch.Entry{}
	}
	return bundle.Scratches
}

// ---------- merge ----------

func mergeBundles(left, right Bundle) Bundle {
	merged := Bundle{
		Version:   1,
		UpdatedAt: max(left.UpdatedAt, right.UpdatedAt),
		Deleted:   mergeDeleted(left.Deleted, right.Deleted),
	}
	merged.Connections = mergeItems(left.Connections, right.Connections,
		func(config driver.Config) string { return "conn:" + config.ID },
		func(config driver.Config) int64 { return config.UpdatedAt }, merged.Deleted)
	merged.Folders = mergeItems(left.Folders, right.Folders,
		func(item folder.Folder) string { return "folder:" + item.ID },
		func(item folder.Folder) int64 { return item.UpdatedAt }, merged.Deleted)
	merged.Scratches = mergeScratches(left.Scratches, right.Scratches, merged.Deleted)
	return merged
}

func mergeScratches(left, right []scratch.Entry, deleted map[string]int64) []scratch.Entry {
	return mergeItems(left, right,
		func(entry scratch.Entry) string { return "scratch:" + entry.ID },
		func(entry scratch.Entry) int64 { return entry.UpdatedAt }, deleted)
}

func mergeItems[T any](left, right []T, key func(T) string, updated func(T) int64, deleted map[string]int64) []T {
	merged := make([]T, 0, len(left)+len(right))
	positions := make(map[string]int, len(left)+len(right))
	for _, items := range [][]T{left, right} {
		for _, item := range items {
			itemKey := key(item)
			if itemKey == "" {
				continue
			}
			if deletedAt, gone := deleted[itemKey]; gone && deletedAt >= updated(item) {
				continue
			}
			if index, ok := positions[itemKey]; ok {
				if updated(item) > updated(merged[index]) {
					merged[index] = item
				}
				continue
			}
			positions[itemKey] = len(merged)
			merged = append(merged, item)
		}
	}
	sort.SliceStable(merged, func(i, j int) bool { return key(merged[i]) < key(merged[j]) })
	return merged
}

func mergeDeleted(left, right map[string]int64) map[string]int64 {
	merged := make(map[string]int64, len(left)+len(right))
	for itemKey, deletedAt := range left {
		merged[itemKey] = deletedAt
	}
	for itemKey, deletedAt := range right {
		if deletedAt > merged[itemKey] {
			merged[itemKey] = deletedAt
		}
	}
	if len(merged) == 0 {
		return nil
	}
	return merged
}

// missingItems lists records that were known at the previous sync but are
// no longer in the local bundle.
func missingItems(known map[string]bool, local Bundle) map[string]int64 {
	if len(known) == 0 {
		return nil
	}
	now := time.Now().UnixMilli()
	present := itemSet(local)
	missing := map[string]int64{}
	for itemKey := range known {
		if !present[itemKey] {
			missing[itemKey] = now
		}
	}
	if len(missing) == 0 {
		return nil
	}
	return missing
}

func itemSet(bundle Bundle) map[string]bool {
	items := make(map[string]bool, len(bundle.Connections)+len(bundle.Folders)+len(bundle.ScratchList()))
	for _, config := range bundle.Connections {
		items["conn:"+config.ID] = true
	}
	for _, item := range bundle.Folders {
		items["folder:"+item.ID] = true
	}
	for _, entry := range bundle.ScratchList() {
		items["scratch:"+entry.ID] = true
	}
	return items
}

// ---------- local state ----------

func (s *Service) loadState() syncState {
	var state syncState
	_, _ = jsonfile.Read(s.statePath, &state)
	return state
}

func (s *Service) saveState(state syncState) error {
	return jsonfile.Write(s.statePath, state, 0o600)
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
