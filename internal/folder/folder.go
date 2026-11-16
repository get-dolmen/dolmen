// Package folder persists the folders that group saved connections.
package folder

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"dolmen/internal/jsonfile"
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
func (s *Store) Save(folder Folder) (Folder, error) {
	folder.Name = strings.TrimSpace(folder.Name)
	if folder.Name == "" {
		return folder, errors.New("folder name is required")
	}
	folder.UpdatedAt = time.Now().UnixMilli()
	s.mu.Lock()
	defer s.mu.Unlock()
	folders, err := s.load()
	if err != nil {
		return folder, err
	}
	if folder.ID == "" {
		folder.ID = uuid.NewString()
		if err := checkParent(folders, folder.ID, folder.ParentID); err != nil {
			return folder, err
		}
		folders = append(folders, folder)
	} else {
		if err := checkParent(folders, folder.ID, folder.ParentID); err != nil {
			return folder, err
		}
		found := false
		for i := range folders {
			if folders[i].ID == folder.ID {
				folders[i], found = folder, true
			}
		}
		if !found {
			folders = append(folders, folder)
		}
	}
	return folder, s.write(folders)
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
	for _, folder := range folders {
		if folder.ID == id {
			parent, found = folder.ParentID, true
			break
		}
	}
	if !found {
		return "", fmt.Errorf("folder %s not found", id)
	}
	kept := make([]Folder, 0, len(folders)-1)
	for _, folder := range folders {
		if folder.ID == id {
			continue
		}
		if folder.ParentID == id {
			folder.ParentID = parent
			folder.UpdatedAt = time.Now().UnixMilli()
		}
		kept = append(kept, folder)
	}
	return parent, s.write(kept)
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
	for _, folder := range folders {
		byID[folder.ID] = folder
	}
	seen := map[string]bool{id: true}
	for current := parent; current != ""; {
		if seen[current] {
			return errors.New("a folder cannot be moved inside itself")
		}
		seen[current] = true
		parentFolder, ok := byID[current]
		if !ok {
			return fmt.Errorf("parent folder %s not found", current)
		}
		current = parentFolder.ParentID
	}
	return nil
}

func (s *Store) load() ([]Folder, error) {
	var folders []Folder
	found, err := jsonfile.Read(s.path, &folders)
	if err != nil {
		return nil, err
	}
	if !found {
		return []Folder{}, nil
	}
	return folders, nil
}

func (s *Store) write(folders []Folder) error {
	return jsonfile.Write(s.path, folders, 0o600)
}
