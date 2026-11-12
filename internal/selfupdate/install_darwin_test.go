//go:build darwin

package selfupdate

import (
	"archive/zip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallArchiveSwapsTheBundle(t *testing.T) {
	parent := t.TempDir()
	installed := filepath.Join(parent, "Dolmen.app")
	if err := os.MkdirAll(filepath.Join(installed, "Contents", "MacOS"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(installed, "Contents", "Info.plist"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(installed, "Contents", "MacOS", "dolmen"), []byte("old binary"), 0o755); err != nil {
		t.Fatal(err)
	}

	archive := filepath.Join(t.TempDir(), "update.zip")
	f, err := os.Create(archive)
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	w, err := zw.Create("dolmen.app/Contents/Info.plist")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("new")); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}

	original := currentBundle
	currentBundle = func() (string, error) { return installed, nil }
	defer func() { currentBundle = original }()

	out, err := installArchive(archive)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := strings.Join(out.Command, " "), "open -n "+installed; got != want {
		t.Errorf("command = %q, want %q", got, want)
	}
	body, err := os.ReadFile(filepath.Join(installed, "Contents", "Info.plist"))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "new" {
		t.Errorf("Info.plist = %q, want the new bundle", body)
	}
	// The old binary must be gone, and no backup may be left behind.
	if _, err := os.Stat(filepath.Join(installed, "Contents", "MacOS", "dolmen")); !os.IsNotExist(err) {
		t.Errorf("the old bundle survived: %v", err)
	}
	entries, err := os.ReadDir(parent)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), ".old-") || strings.HasPrefix(e.Name(), ".dolmen-update-") {
			t.Errorf("leftover %s", e.Name())
		}
	}
}

func TestAppBundleRejectsNonBundle(t *testing.T) {
	// The test binary does not live in a .app, so detection must fail.
	if bundle, err := appBundle(); err == nil {
		t.Errorf("appBundle() = %q, want an error", bundle)
	}
}
