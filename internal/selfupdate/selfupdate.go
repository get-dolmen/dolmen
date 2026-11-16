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
func Apply(ctx context.Context, options Options) (Outcome, error) {
	if options.Repo == "" || options.Tag == "" || options.Asset == "" {
		return Outcome{}, errors.New("no release to install")
	}
	dir, err := os.MkdirTemp("", "dolmen-update-")
	if err != nil {
		return Outcome{}, err
	}
	defer os.RemoveAll(dir)

	archive := filepath.Join(dir, options.Asset)
	base := "https://github.com/" + options.Repo + "/releases/download/" + options.Tag + "/"
	report := options.Progress
	if report == nil {
		report = func(string, int64, int64) {}
	}
	report("download", 0, 0)

	if _, err := Download(ctx, base+options.Asset, archive, func(done, total int64) {
		report("download", done, total)
	}); err != nil {
		return Outcome{}, err
	}

	report("verify", 0, 0)
	sums, err := FetchText(ctx, base+"SHA256SUMS.txt", 1<<20)
	if err != nil {
		return Outcome{}, fmt.Errorf("could not download SHA256SUMS.txt: %w", err)
	}
	expected, ok := ChecksumFor(sums, options.Asset)
	if !ok {
		return Outcome{}, fmt.Errorf("%s is not listed in SHA256SUMS.txt", options.Asset)
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

// newRequest builds the GET request used to reach the release, with the
// updater's User-Agent.
func newRequest(ctx context.Context, url string) (*http.Request, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("User-Agent", "Dolmen-updater")
	return request, nil
}

// Download fetches url into destination, calling progress as bytes arrive.
func Download(ctx context.Context, url, destination string, progress func(done, total int64)) (int64, error) {
	request, err := newRequest(ctx, url)
	if err != nil {
		return 0, err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return 0, fmt.Errorf("could not download the update: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("could not download the update: %s", response.Status)
	}
	file, err := os.Create(destination)
	if err != nil {
		return 0, err
	}
	defer file.Close()

	buffer := make([]byte, 64<<10)
	var done int64
	lastReport := time.Time{}
	for {
		read, readErr := response.Body.Read(buffer)
		if read > 0 {
			if _, writeErr := file.Write(buffer[:read]); writeErr != nil {
				return done, writeErr
			}
			done += int64(read)
			if progress != nil && (time.Since(lastReport) > 150*time.Millisecond || done == response.ContentLength) {
				progress(done, response.ContentLength)
				lastReport = time.Now()
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return done, fmt.Errorf("could not download the update: %w", readErr)
		}
	}
	if progress != nil {
		progress(done, response.ContentLength)
	}
	return done, file.Close()
}

// FetchText downloads a small text file, such as SHA256SUMS.txt.
func FetchText(ctx context.Context, url string, limit int64) (string, error) {
	request, err := newRequest(ctx, url)
	if err != nil {
		return "", err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s", response.Status)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit))
	return string(data), err
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
func SHA256File(filename string) (string, error) {
	file, err := os.Open(filename)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

// ExtractFile writes one regular file from a .tar.gz archive to destination.
func ExtractFile(archive, name, destination string, mode os.FileMode) error {
	file, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer file.Close()
	gzipReader, err := gzip.NewReader(file)
	if err != nil {
		return fmt.Errorf("could not read the update archive: %w", err)
	}
	defer gzipReader.Close()
	tarReader := tar.NewReader(gzipReader)
	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			return fmt.Errorf("%s is missing from the update archive", name)
		}
		if err != nil {
			return fmt.Errorf("could not read the update archive: %w", err)
		}
		if path.Clean(header.Name) != name || header.Typeflag != tar.TypeReg {
			continue
		}
		output, err := os.OpenFile(destination, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
		if err != nil {
			return err
		}
		if _, err := io.Copy(output, tarReader); err != nil {
			output.Close()
			return err
		}
		if err := output.Close(); err != nil {
			return err
		}
		return os.Chmod(destination, mode)
	}
}

// executablePath returns the path of the running binary, with symlinks
// resolved.
func executablePath() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(executable); err == nil {
		return resolved, nil
	}
	return executable, nil
}

func copyFile(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o700)
	if err != nil {
		return err
	}
	if _, err := io.Copy(output, input); err != nil {
		output.Close()
		return err
	}
	return output.Close()
}
