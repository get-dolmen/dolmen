//go:build windows

package selfupdate

import (
	"fmt"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// installArchive keeps the downloaded setup.exe and runs it. Dolmen installed
// in Program Files cannot overwrite its own executable without elevation, so
// the NSIS installer (which asks for it) finishes the upgrade.
//
// When Dolmen runs from an installed copy, the installer runs silently over
// that folder with /UPDATE: it waits for Dolmen to exit, replaces the files,
// keeps the user's shortcuts as they are and starts Dolmen again. A copy run
// from the zip gets the regular setup wizard instead.
func installArchive(archive string) (Outcome, error) {
	cacheDir, err := os.UserCacheDir()
	if err != nil {
		cacheDir = os.TempDir()
	}
	destinationDir := filepath.Join(cacheDir, "Dolmen", "updates")
	if err := os.MkdirAll(destinationDir, 0o700); err != nil {
		return Outcome{}, err
	}
	destination := filepath.Join(destinationDir, filepath.Base(archive))
	if err := copyFile(archive, destination); err != nil {
		return Outcome{}, err
	}

	installDir, installed := installedDir()
	parameters := ""
	message := "the installer is open and Dolmen will close; finish the setup to complete the update"
	if installed {
		// NSIS reads /D= raw up to the end of the command line: it must come
		// last and must not be quoted, even when the path has spaces.
		parameters = "/S /UPDATE /D=" + installDir
		message = "Dolmen will close, update itself and start again"
	}
	// ShellExecute raises the installer's UAC prompt when Dolmen was installed
	// per machine.
	if err := shellExecute(destination, parameters); err != nil {
		return Outcome{}, fmt.Errorf("could not start the installer: %w", err)
	}
	return Outcome{Message: message}, nil
}

// installedDir returns the folder of the running executable when it was
// installed by the NSIS setup (its uninstaller sits next to it).
func installedDir() (string, bool) {
	executable, err := os.Executable()
	if err != nil {
		return "", false
	}
	if resolved, err := filepath.EvalSymlinks(executable); err == nil {
		executable = resolved
	}
	dir := filepath.Dir(executable)
	if _, err := os.Stat(filepath.Join(dir, "uninstall.exe")); err != nil {
		return "", false
	}
	return dir, true
}

func shellExecute(file, parameters string) error {
	verb, err := windows.UTF16PtrFromString("open")
	if err != nil {
		return err
	}
	filePointer, err := windows.UTF16PtrFromString(file)
	if err != nil {
		return err
	}
	var parametersPointer *uint16
	if parameters != "" {
		if parametersPointer, err = windows.UTF16PtrFromString(parameters); err != nil {
			return err
		}
	}
	return windows.ShellExecute(0, verb, filePointer, parametersPointer, nil, windows.SW_SHOWNORMAL)
}
