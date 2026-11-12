//go:build windows

package selfupdate

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

// installArchive keeps the downloaded setup.exe and opens it. Dolmen installed
// in Program Files cannot overwrite its own executable without elevation, so
// the NSIS installer (which asks for it) finishes the upgrade.
func installArchive(archive string) (Outcome, error) {
	dir, err := os.UserCacheDir()
	if err != nil {
		dir = os.TempDir()
	}
	destDir := filepath.Join(dir, "Dolmen", "updates")
	if err := os.MkdirAll(destDir, 0o700); err != nil {
		return Outcome{}, err
	}
	dest := filepath.Join(destDir, filepath.Base(archive))
	if err := copyFile(archive, dest); err != nil {
		return Outcome{}, err
	}

	// `start` goes through ShellExecute, which raises the installer's UAC
	// prompt when Dolmen was installed per machine.
	cmd := exec.Command("cmd", "/c", "start", "", dest)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := cmd.Run(); err != nil {
		return Outcome{}, fmt.Errorf("could not start the installer: %w", err)
	}
	return Outcome{Message: "the installer is open and Dolmen will close; finish the setup to complete the update"}, nil
}
