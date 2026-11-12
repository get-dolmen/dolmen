//go:build darwin

package selfupdate

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// currentBundle returns the .app directory this process runs from; replaced
// in tests.
var currentBundle = appBundle

// installArchive swaps the extracted dolmen.app for the running one. The app
// is renamed aside first, so a failed move leaves the old bundle in place.
func installArchive(archive string) (Outcome, error) {
	bundle, err := currentBundle()
	if err != nil {
		return Outcome{}, err
	}
	parent := filepath.Dir(bundle)
	work, err := os.MkdirTemp(parent, ".dolmen-update-")
	if err != nil {
		return Outcome{}, fmt.Errorf("cannot write to %s: %w (install the release with install.sh instead)", parent, err)
	}
	defer os.RemoveAll(work)

	if out, err := exec.Command("ditto", "-x", "-k", archive, work).CombinedOutput(); err != nil {
		return Outcome{}, fmt.Errorf("could not extract the update: %v: %s", err, strings.TrimSpace(string(out)))
	}
	fresh, err := findApp(work)
	if err != nil {
		return Outcome{}, err
	}

	backup := filepath.Join(parent, "."+filepath.Base(bundle)+".old-"+strconv.FormatInt(time.Now().UnixNano(), 10))
	if err := os.Rename(bundle, backup); err != nil {
		return Outcome{}, fmt.Errorf("could not replace %s: %w", bundle, err)
	}
	if err := os.Rename(fresh, bundle); err != nil {
		_ = os.Rename(backup, bundle)
		return Outcome{}, fmt.Errorf("could not replace %s: %w", bundle, err)
	}
	// The release is not signed or notarised; our own download has no
	// quarantine attribute, but clear it in case one was added.
	_ = exec.Command("xattr", "-dr", "com.apple.quarantine", bundle).Run()
	// The old bundle is still mapped by this dying process; unlinking is
	// fine, and a leftover backup is harmless if macOS refuses.
	_ = os.RemoveAll(backup)

	return Outcome{Command: []string{"open", "-n", bundle}}, nil
}

// appBundle returns the .app directory this process runs from.
func appBundle() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	bundle := filepath.Dir(filepath.Dir(filepath.Dir(exe)))
	if !strings.HasSuffix(bundle, ".app") ||
		filepath.Base(filepath.Dir(exe)) != "MacOS" ||
		filepath.Base(filepath.Dir(filepath.Dir(exe))) != "Contents" {
		return "", errors.New("Dolmen is not running from an app bundle; install the release with install.sh")
	}
	if strings.Contains(bundle, "/AppTranslocation/") {
		return "", errors.New("Dolmen is running from a temporary location; move it to /Applications before updating")
	}
	return bundle, nil
}

// findApp returns the single .app bundle inside an extraction directory.
func findApp(dir string) (string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}
	var found []string
	for _, e := range entries {
		if e.IsDir() && strings.HasSuffix(e.Name(), ".app") {
			found = append(found, filepath.Join(dir, e.Name()))
		}
	}
	if len(found) != 1 {
		return "", fmt.Errorf("the update archive does not contain an app bundle")
	}
	if _, err := os.Stat(filepath.Join(found[0], "Contents", "Info.plist")); err != nil {
		return "", fmt.Errorf("the update archive does not contain a valid app bundle")
	}
	return found[0], nil
}
