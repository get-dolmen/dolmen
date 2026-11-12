// Package selfupdate downloads a Dolmen release and installs it over the
// running copy, so the version button can update the app in place.
//
// The release asset is always verified against the release's SHA256SUMS.txt
// before anything is replaced: a download that does not match is discarded.
package selfupdate

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// ProgressFunc reports how an update is going. Phase is "download", "verify"
// or "install"; done and total are byte counts when they are known.
type ProgressFunc func(phase string, done, total int64)

// Options describes the release to install.
type Options struct {
	Repo     string // owner/repo on GitHub
	Tag      string // release tag, e.g. v0.1.0
	Asset    string // asset file name, from AssetName
	Progress ProgressFunc
}

// Outcome tells the caller how to start the new version. Command is empty
// when the platform's installer completes the update by itself.
type Outcome struct {
	Command []string
	Message string
}

// AssetName returns the release asset that replaces the running build on the
// given platform. ok is false when no in-place update exists there.
func AssetName(tag, goos, goarch string) (name string, ok bool) {
	switch goos {
	case "darwin":
		return "dolmen-" + tag + "-macos-universal.zip", true
	case "linux":
		if goarch != "amd64" {
			return "", false
		}
		return "dolmen-" + tag + "-linux-amd64.tar.gz", true
	case "windows":
		if goarch != "amd64" {
			return "", false
		}
		return "dolmen-" + tag + "-windows-amd64-setup.exe", true
	}
	return "", false
}

// Apply downloads the release asset, verifies its checksum and installs it.
func Apply(ctx context.Context, o Options) (Outcome, error) {
	if o.Repo == "" || o.Tag == "" || o.Asset == "" {
		return Outcome{}, errors.New("no release to install")
	}
	dir, err := os.MkdirTemp("", "dolmen-update-")
	if err != nil {
		return Outcome{}, err
	}
	defer os.RemoveAll(dir)

	archive := filepath.Join(dir, o.Asset)
	base := "https://github.com/" + o.Repo + "/releases/download/" + o.Tag + "/"
	report := o.Progress
	if report == nil {
		report = func(string, int64, int64) {}
	}
	report("download", 0, 0)

	if _, err := Download(ctx, base+o.Asset, archive, func(done, total int64) {
		report("download", done, total)
	}); err != nil {
		return Outcome{}, err
	}

	report("verify", 0, 0)
	sums, err := FetchText(ctx, base+"SHA256SUMS.txt", 1<<20)
	if err != nil {
		return Outcome{}, fmt.Errorf("could not download SHA256SUMS.txt: %w", err)
	}
	expected, ok := ChecksumFor(sums, o.Asset)
	if !ok {
		return Outcome{}, fmt.Errorf("%s is not listed in SHA256SUMS.txt", o.Asset)
	}
	actual, err := SHA256File(archive)
	if err != nil {
		return Outcome{}, err
	}
	if !strings.EqualFold(actual, expected) {
		return Outcome{}, errors.New("the downloaded update does not match its checksum; nothing was changed")
	}

	report("install", 0, 0)
	return installArchive(archive)
}

// Download fetches url into dest, calling progress as bytes arrive.
func Download(ctx context.Context, url, dest string, progress func(done, total int64)) (int64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("User-Agent", "Dolmen-updater")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, fmt.Errorf("could not download the update: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("could not download the update: %s", resp.Status)
	}
	f, err := os.Create(dest)
	if err != nil {
		return 0, err
	}
	defer f.Close()

	buf := make([]byte, 64<<10)
	var done int64
	last := time.Time{}
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				return done, werr
			}
			done += int64(n)
			if progress != nil && (time.Since(last) > 150*time.Millisecond || done == resp.ContentLength) {
				progress(done, resp.ContentLength)
				last = time.Now()
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return done, fmt.Errorf("could not download the update: %w", rerr)
		}
	}
	if progress != nil {
		progress(done, resp.ContentLength)
	}
	return done, f.Close()
}

// FetchText downloads a small text file, such as SHA256SUMS.txt.
func FetchText(ctx context.Context, url string, limit int64) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "Dolmen-updater")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s", resp.Status)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit))
	return string(b), err
}

// ChecksumFor returns the SHA-256 listed for name in a sha256sum file.
func ChecksumFor(sums, name string) (string, bool) {
	for _, line := range strings.Split(sums, "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		if strings.TrimPrefix(fields[1], "*") == name {
			return fields[0], true
		}
	}
	return "", false
}

// SHA256File hashes a file.
func SHA256File(name string) (string, error) {
	f, err := os.Open(name)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// ExtractFile writes one regular file from a .tar.gz archive to dest.
func ExtractFile(archive, name, dest string, mode os.FileMode) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("could not read the update archive: %w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return fmt.Errorf("%s is missing from the update archive", name)
		}
		if err != nil {
			return fmt.Errorf("could not read the update archive: %w", err)
		}
		if path.Clean(h.Name) != name || h.Typeflag != tar.TypeReg {
			continue
		}
		out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, tr); err != nil {
			out.Close()
			return err
		}
		if err := out.Close(); err != nil {
			return err
		}
		return os.Chmod(dest, mode)
	}
}

func copyFile(src, dest string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o700)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
