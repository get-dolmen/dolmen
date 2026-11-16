// Package jsonfile reads and writes the small JSON documents Dolmen keeps on
// disk: indented like the rest of the settings files, written atomically, and
// tolerant of a file that does not exist yet.
package jsonfile

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"dolmen/internal/atomicfile"
)

// Read decodes the JSON document at path into target. It reports found=false
// and leaves target untouched when the file does not exist.
func Read(path string, target any) (found bool, err error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := json.Unmarshal(data, target); err != nil {
		return true, fmt.Errorf("reading %s: %w", path, err)
	}
	return true, nil
}

// Write encodes value as indented JSON and replaces the file atomically.
func Write(path string, value any, mode os.FileMode) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return atomicfile.Write(path, data, mode)
}
