// Package folder persists the folders that group saved connections.
package folder

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Folder is a named group of connections. ParentID creates nesting; an
// empty ParentID places the folder at the root of the explorer.
type Folder struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	ParentID string `json:"parentId,omitempty"`
	// UpdatedAt is the unix-ms time of the last local change, for git sync.
	UpdatedAt int64 `json:"updatedAt,omitempty"`
}

// Store keeps folders in a JSON file next to connections.json.
type Store struct {
	path string
	mu   sync.Mutex
}

func NewStore(dir string) *Store { return &Store{path: filepath.Join(dir, "folders.json")} }

func (s *Store) List() ([]Folder, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.load()
}

// Save inserts or renames a folder and returns it with an ID.
func (s *Store) Save(f Folder) (Folder, error) {
	f.Name = strings.TrimSpace(f.Name)
	if f.Name == "" {
		return f, errors.New("folder name is required")
	}
	f.UpdatedAt = time.Now().UnixMilli()
	s.mu.Lock()
	defer s.mu.Unlock()
	folders, err := s.load()
	if err != nil {
		return f, err
	}
	if f.ID == "" {
		f.ID = uuid.NewString()
		if err := checkParent(folders, f.ID, f.ParentID); err != nil {
			return f, err
		}
		folders = append(folders, f)
	} else {
		if err := checkParent(folders, f.ID, f.ParentID); err != nil {
			return f, err
		}
		found := false
		for i := range folders {
			if folders[i].ID == f.ID {
				folders[i], found = f, true
			}
		}
		if !found {
			folders = append(folders, f)
		}
	}
	return f, s.write(folders)
}

// Delete removes a folder and moves its children (and, at the caller's
// level, its connections) to the deleted folder's parent. It returns that
// parent ID, "" for the root.
func (s *Store) Delete(id string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	folders, err := s.load()
	if err != nil {
		return "", err
	}
	parent := ""
	found := false
	for _, f := range folders {
		if f.ID == id {
			parent, found = f.ParentID, true
			break
		}
	}
	if !found {
		return "", fmt.Errorf("folder %s not found", id)
	}
	out := make([]Folder, 0, len(folders)-1)
	for _, f := range folders {
		if f.ID == id {
			continue
		}
		if f.ParentID == id {
			f.ParentID = parent
			f.UpdatedAt = time.Now().UnixMilli()
		}
		out = append(out, f)
	}
	return parent, s.write(out)
}

// Replace rewrites the whole folder list (used by git sync after merging).
func (s *Store) Replace(folders []Folder) error {
	if folders == nil {
		folders = []Folder{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.write(folders)
}

// checkParent refuses a missing parent and folder cycles.
func checkParent(folders []Folder, id, parent string) error {
	if parent == "" {
		return nil
	}
	if parent == id {
		return errors.New("a folder cannot be its own parent")
	}
	byID := make(map[string]Folder, len(folders))
	for _, f := range folders {
		byID[f.ID] = f
	}
	seen := map[string]bool{id: true}
	for cur := parent; cur != ""; {
		if seen[cur] {
			return errors.New("a folder cannot be moved inside itself")
		}
		seen[cur] = true
		p, ok := byID[cur]
		if !ok {
			return fmt.Errorf("parent folder %s not found", cur)
		}
		cur = p.ParentID
	}
	return nil
}

func (s *Store) load() ([]Folder, error) {
	b, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return []Folder{}, nil
	}
	if err != nil {
		return nil, err
	}
	var folders []Folder
	if err := json.Unmarshal(b, &folders); err != nil {
		return nil, fmt.Errorf("reading %s: %w", s.path, err)
	}
	return folders, nil
}

func (s *Store) write(folders []Folder) error {
	b, err := json.MarshalIndent(folders, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}
