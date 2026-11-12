package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"runtime"
	"strings"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"dolmen/internal/selfupdate"
)

type UpdateInfo struct {
	Current string `json:"current"`
	Latest  string `json:"latest"`
	Newer   bool   `json:"newer"`
	URL     string `json:"url"`
	Notes   string `json:"notes,omitempty"`
	// Asset is the release file that replaces this build in place; nil when
	// the platform has no such build.
	Asset *UpdateAsset `json:"asset,omitempty"`
}

// UpdateAsset is the release file the app installs over itself.
type UpdateAsset struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	URL  string `json:"url"`
}

type releaseAsset struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	URL  string `json:"browser_download_url"`
}

type release struct {
	TagName string         `json:"tag_name"`
	HTMLURL string         `json:"html_url"`
	Body    string         `json:"body"`
	Assets  []releaseAsset `json:"assets"`
}

// fetchRelease reads a release of this project from GitHub. An empty tag
// means the latest published release.
func fetchRelease(tag string) (release, error) {
	if repo == "" {
		return release{}, errors.New("update checks are only available in release builds")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	endpoint := "https://api.github.com/repos/" + repo + "/releases/latest"
	if tag != "" {
		endpoint = "https://api.github.com/repos/" + repo + "/releases/tags/" + url.PathEscape(tag)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return release{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "Dolmen-update-check")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return release{}, fmt.Errorf("could not reach GitHub: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		if tag == "" {
			return release{}, errors.New("no release has been published yet")
		}
		return release{}, fmt.Errorf("release %s was not found", tag)
	}
	if resp.StatusCode != http.StatusOK {
		return release{}, fmt.Errorf("GitHub answered %s", resp.Status)
	}
	var rel release
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return release{}, err
	}
	return rel, nil
}

// CheckForUpdate asks GitHub for the latest published release of this
// project. It only runs when the user clicks the version button.
func (a *App) CheckForUpdate() (UpdateInfo, error) {
	info := UpdateInfo{Current: version}
	rel, err := fetchRelease("")
	if err != nil {
		return info, err
	}
	info.Latest, info.URL = rel.TagName, rel.HTMLURL
	if len(rel.Body) > 2000 {
		rel.Body = rel.Body[:2000] + "…"
	}
	info.Notes = rel.Body
	info.Newer = newerVersion(rel.TagName, version)
	if info.Newer {
		if name, ok := selfupdate.AssetName(rel.TagName, runtime.GOOS, runtime.GOARCH); ok {
			for _, asset := range rel.Assets {
				if asset.Name == name {
					info.Asset = &UpdateAsset{Name: asset.Name, Size: asset.Size, URL: asset.URL}
					break
				}
			}
		}
	}
	return info, nil
}

// OpenReleasePage opens a GitHub page of this project in the browser.
func (a *App) OpenReleasePage(link string) error {
	u, err := url.Parse(link)
	if err != nil || u.Scheme != "https" || u.Host != "github.com" || (repo != "" && !strings.HasPrefix(u.Path, "/"+repo+"/")) {
		return errors.New("refusing to open a non-release link")
	}
	wailsruntime.BrowserOpenURL(a.ctx, link)
	return nil
}

// InstallResult reports an installed update.
type InstallResult struct {
	Version string `json:"version"`
	// Relaunch is true when Dolmen must restart itself to run the new build;
	// otherwise the platform's installer completes the update.
	Relaunch bool   `json:"relaunch"`
	Message  string `json:"message,omitempty"`
}

// InstallProgress is emitted as "update:progress" while an update runs.
type InstallProgress struct {
	Phase    string `json:"phase"` // download, verify or install
	Received int64  `json:"received"`
	Total    int64  `json:"total"`
}

// A release tag is part of a download URL; only accept plain versions.
var releaseTag = regexp.MustCompile(`^v[0-9][0-9A-Za-z.+-]*$`)

// InstallUpdate downloads the release asset for this platform, verifies its
// checksum and installs it over the running copy.
func (a *App) InstallUpdate(tag string) (InstallResult, error) {
	if err := a.ready(); err != nil {
		return InstallResult{}, err
	}
	if repo == "" {
		return InstallResult{}, errors.New("in-place updates are only available in release builds")
	}
	if !releaseTag.MatchString(tag) {
		return InstallResult{}, errors.New("invalid release tag")
	}
	a.updateMu.Lock()
	a.pendingRestart = nil
	a.updateInstalled = false
	a.updateMu.Unlock()
	name, ok := selfupdate.AssetName(tag, runtime.GOOS, runtime.GOARCH)
	if !ok {
		return InstallResult{}, errors.New("no in-place update is published for this platform; open the release page instead")
	}
	// Make sure the release still exists and carries the asset before
	// downloading anything.
	rel, err := fetchRelease(tag)
	if err != nil {
		return InstallResult{}, err
	}
	found := false
	for _, asset := range rel.Assets {
		if asset.Name == name {
			found = true
			break
		}
	}
	if !found {
		return InstallResult{}, fmt.Errorf("%s is missing from the release; open the release page instead", name)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	out, err := selfupdate.Apply(ctx, selfupdate.Options{
		Repo:  repo,
		Tag:   rel.TagName,
		Asset: name,
		Progress: func(phase string, done, total int64) {
			wailsruntime.EventsEmit(a.ctx, "update:progress", InstallProgress{Phase: phase, Received: done, Total: total})
		},
	})
	if err != nil {
		return InstallResult{}, err
	}
	a.updateMu.Lock()
	a.pendingRestart = out.Command
	a.updateInstalled = true
	a.updateMu.Unlock()
	return InstallResult{Version: rel.TagName, Relaunch: len(out.Command) > 0, Message: out.Message}, nil
}

// RestartApp starts the freshly installed build and quits this one.
func (a *App) RestartApp() error {
	a.updateMu.Lock()
	command := a.pendingRestart
	installed := a.updateInstalled
	a.updateMu.Unlock()
	if !installed {
		return errors.New("no update has been installed")
	}
	if len(command) > 0 {
		if err := selfupdate.Relaunch(command); err != nil {
			return fmt.Errorf("could not restart Dolmen: %w", err)
		}
	}
	go func() {
		// Let the frontend show the update message first.
		time.Sleep(800 * time.Millisecond)
		wailsruntime.Quit(a.ctx)
	}()
	return nil
}
