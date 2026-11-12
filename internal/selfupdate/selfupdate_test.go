package selfupdate

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestAssetName(t *testing.T) {
	cases := []struct {
		tag, goos, goarch string
		want              string
		ok                bool
	}{
		{"v0.1.0", "darwin", "arm64", "dolmen-v0.1.0-macos-universal.zip", true},
		{"v0.1.0", "darwin", "amd64", "dolmen-v0.1.0-macos-universal.zip", true},
		{"v0.1.0", "linux", "amd64", "dolmen-v0.1.0-linux-amd64.tar.gz", true},
		{"v0.1.0", "linux", "arm64", "", false},
		{"v0.1.0", "windows", "amd64", "dolmen-v0.1.0-windows-amd64-setup.exe", true},
		{"v0.1.0", "windows", "arm64", "", false},
		{"v0.1.0", "freebsd", "amd64", "", false},
	}
	for _, c := range cases {
		got, ok := AssetName(c.tag, c.goos, c.goarch)
		if got != c.want || ok != c.ok {
			t.Errorf("AssetName(%q, %q, %q) = %q, %v; want %q, %v", c.tag, c.goos, c.goarch, got, ok, c.want, c.ok)
		}
	}
}

func TestChecksumFor(t *testing.T) {
	sums := "aaa  dolmen-v0.1.0-linux-amd64.tar.gz\n" +
		"bbb *dolmen-v0.1.0-macos-universal.zip\n" +
		"garbage line\n"
	if got, ok := ChecksumFor(sums, "dolmen-v0.1.0-linux-amd64.tar.gz"); !ok || got != "aaa" {
		t.Errorf("first entry = %q, %v", got, ok)
	}
	if got, ok := ChecksumFor(sums, "dolmen-v0.1.0-macos-universal.zip"); !ok || got != "bbb" {
		t.Errorf("binary-mode entry = %q, %v", got, ok)
	}
	if _, ok := ChecksumFor(sums, "other.zip"); ok {
		t.Error("missing entry reported as found")
	}
}

func TestExtractFile(t *testing.T) {
	archive := filepath.Join(t.TempDir(), "update.tar.gz")
	f, err := os.Create(archive)
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	for _, name := range []string{"README", "dolmen"} {
		body := []byte("contents of " + name)
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(body); err != nil {
			t.Fatal(err)
		}
	}
	tw.Close()
	gz.Close()
	f.Close()

	dest := filepath.Join(t.TempDir(), "dolmen")
	if err := ExtractFile(archive, "dolmen", dest, 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "contents of dolmen" {
		t.Errorf("extracted %q", got)
	}
	if info, err := os.Stat(dest); err != nil || info.Mode().Perm() != 0o755 {
		t.Errorf("mode = %v, %v", info, err)
	}

	if err := ExtractFile(archive, "missing", dest, 0o755); err == nil {
		t.Error("extracting a missing entry succeeded")
	}
}

func TestDownload(t *testing.T) {
	body := []byte("payload")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "7")
		w.Write(body)
	}))
	defer srv.Close()

	dest := filepath.Join(t.TempDir(), "asset")
	var lastDone, lastTotal int64
	n, err := Download(context.Background(), srv.URL, dest, func(done, total int64) {
		lastDone, lastTotal = done, total
	})
	if err != nil {
		t.Fatal(err)
	}
	if n != int64(len(body)) || lastDone != n || lastTotal != int64(len(body)) {
		t.Errorf("downloaded %d (progress %d/%d)", n, lastDone, lastTotal)
	}
	got, err := os.ReadFile(dest)
	if err != nil || string(got) != string(body) {
		t.Errorf("file = %q, %v", got, err)
	}
	sum, err := SHA256File(dest)
	if err != nil {
		t.Fatal(err)
	}
	want := sha256.Sum256(body)
	if sum != hex.EncodeToString(want[:]) {
		t.Errorf("sha256 = %s", sum)
	}
}

func TestDownloadHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	if _, err := Download(context.Background(), srv.URL, filepath.Join(t.TempDir(), "x"), nil); err == nil {
		t.Error("a 404 download succeeded")
	}
}
