// Package atomicfile writes files without leaving a partial one behind.
package atomicfile

import "os"

// Write creates or replaces path with data. The content goes to a temporary
// file in the same directory and is then renamed, so a crash never leaves a
// half-written settings or scratch file behind.
func Write(path string, data []byte, mode os.FileMode) error {
	temporaryPath := path + ".tmp"
	if err := os.WriteFile(temporaryPath, data, mode); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}
