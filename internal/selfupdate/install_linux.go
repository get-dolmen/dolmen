//go:build linux

package selfupdate

import (
	"fmt"
	"os"
	"path/filepath"
)

// installArchive replaces the running binary with the one from the archive.
// The new file is written next to it and renamed over, so a failed download
// or extract never leaves a half-written executable.
func installArchive(archive string) (Outcome, error) {
	executable, err := executablePath()
	if err != nil {
		return Outcome{}, err
	}
	dir := filepath.Dir(executable)

	temporary, err := os.CreateTemp(dir, ".dolmen-update-*")
	if err != nil {
		return Outcome{}, fmt.Errorf("cannot write to %s: %w (install the release with install.sh instead)", dir, err)
	}
	stagedPath := temporary.Name()
	temporary.Close()
	defer os.Remove(stagedPath)

	if err := ExtractFile(archive, "dolmen", stagedPath, 0o755); err != nil {
		return Outcome{}, err
	}
	if err := os.Rename(stagedPath, executable); err != nil {
		return Outcome{}, fmt.Errorf("could not replace %s: %w", executable, err)
	}
	return Outcome{Command: []string{executable}}, nil
}
