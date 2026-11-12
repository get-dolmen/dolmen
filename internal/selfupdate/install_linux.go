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
	exe, err := os.Executable()
	if err != nil {
		return Outcome{}, err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	dir := filepath.Dir(exe)

	tmp, err := os.CreateTemp(dir, ".dolmen-update-*")
	if err != nil {
		return Outcome{}, fmt.Errorf("cannot write to %s: %w (install the release with install.sh instead)", dir, err)
	}
	name := tmp.Name()
	tmp.Close()
	defer os.Remove(name)

	if err := ExtractFile(archive, "dolmen", name, 0o755); err != nil {
		return Outcome{}, err
	}
	if err := os.Rename(name, exe); err != nil {
		return Outcome{}, fmt.Errorf("could not replace %s: %w", exe, err)
	}
	return Outcome{Command: []string{exe}}, nil
}
