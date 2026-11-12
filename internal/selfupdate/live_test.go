//go:build darwin

package selfupdate

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// TestLiveApply checks the whole update path against a real GitHub release:
// download, SHA-256 verification, extraction and the bundle swap. It needs
// the network and a published release, so it only runs on demand:
//
//	DOLMEN_LIVE_UPDATE=1 DOLMEN_LIVE_TAG=v0.1.0 go test ./internal/selfupdate/ -run TestLiveApply -v
func TestLiveApply(t *testing.T) {
	if os.Getenv("DOLMEN_LIVE_UPDATE") == "" {
		t.Skip("set DOLMEN_LIVE_UPDATE=1 to run against a real release")
	}
	tag := os.Getenv("DOLMEN_LIVE_TAG")
	if tag == "" {
		tag = "v0.1.0"
	}
	asset := "dolmen-" + tag + "-macos-universal.zip"

	parent := t.TempDir()
	installed := filepath.Join(parent, "Dolmen.app")
	if err := os.MkdirAll(filepath.Join(installed, "Contents", "MacOS"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(installed, "Contents", "Info.plist"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}

	original := currentBundle
	currentBundle = func() (string, error) { return installed, nil }
	defer func() { currentBundle = original }()

	out, err := Apply(context.Background(), Options{
		Repo:     "get-dolmen/dolmen",
		Tag:      tag,
		Asset:    asset,
		Progress: func(phase string, done, total int64) { t.Logf("%s %d/%d", phase, done, total) },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("command: %v", out.Command)

	exe := filepath.Join(installed, "Contents", "MacOS", "dolmen")
	info, err := os.Stat(exe)
	if err != nil {
		t.Fatalf("new executable: %v", err)
	}
	if info.Size() < 1<<20 {
		t.Errorf("new executable is only %d bytes", info.Size())
	}
	if body, err := os.ReadFile(filepath.Join(installed, "Contents", "Info.plist")); err != nil || len(body) == 0 || string(body) == "old" {
		t.Errorf("Info.plist not replaced: %v", err)
	}
}
