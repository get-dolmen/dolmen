package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// Set at build time by the release workflow:
//
//	-ldflags "-X main.version=v1.2.3 -X main.repo=owner/dolmen -X main.commit=abc123"
var (
	version = "dev"
	repo    = ""
	commit  = ""
)

type VersionInfo struct {
	Version string `json:"version"`
	Repo    string `json:"repo"`
	Commit  string `json:"commit"`
}

// Version reports the running build.
func (a *App) Version() VersionInfo {
	return VersionInfo{Version: version, Repo: repo, Commit: commit}
}

type UpdateInfo struct {
	Current string `json:"current"`
	Latest  string `json:"latest"`
	Newer   bool   `json:"newer"`
	URL     string `json:"url"`
	Notes   string `json:"notes,omitempty"`
}

// CheckForUpdate asks GitHub for the latest published release of this
// project. It only runs when the user clicks the version button.
func (a *App) CheckForUpdate() (UpdateInfo, error) {
	info := UpdateInfo{Current: version}
	if repo == "" {
		return info, errors.New("update checks are only available in release builds")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.github.com/repos/"+repo+"/releases/latest", nil)
	if err != nil {
		return info, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "Dolmen-update-check")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return info, fmt.Errorf("could not reach GitHub: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return info, errors.New("no release has been published yet")
	}
	if resp.StatusCode != http.StatusOK {
		return info, fmt.Errorf("GitHub answered %s", resp.Status)
	}
	var rel struct {
		TagName string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
		Body    string `json:"body"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return info, err
	}
	info.Latest, info.URL = rel.TagName, rel.HTMLURL
	if len(rel.Body) > 2000 {
		rel.Body = rel.Body[:2000] + "…"
	}
	info.Notes = rel.Body
	info.Newer = newerVersion(rel.TagName, version)
	return info, nil
}

// OpenReleasePage opens a GitHub page of this project in the browser.
func (a *App) OpenReleasePage(link string) error {
	u, err := url.Parse(link)
	if err != nil || u.Scheme != "https" || u.Host != "github.com" || (repo != "" && !strings.HasPrefix(u.Path, "/"+repo+"/")) {
		return errors.New("refusing to open a non-release link")
	}
	runtime.BrowserOpenURL(a.ctx, link)
	return nil
}

// newerVersion reports whether candidate is a later semantic version than
// current. Development builds ("dev", "0.0.0-dev…") are always older.
func newerVersion(candidate, current string) bool {
	c, ok1 := parseVersion(candidate)
	cur, ok2 := parseVersion(current)
	if !ok1 {
		return false
	}
	if !ok2 {
		return true
	}
	for i := range 3 {
		if c.nums[i] != cur.nums[i] {
			return c.nums[i] > cur.nums[i]
		}
	}
	// 1.2.0 > 1.2.0-rc.1; two pre-releases compare as strings.
	switch {
	case c.pre == cur.pre:
		return false
	case c.pre == "":
		return true
	case cur.pre == "":
		return false
	}
	return c.pre > cur.pre
}

type semver struct {
	nums [3]int
	pre  string
}

func parseVersion(v string) (semver, bool) {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexByte(v, '+'); i >= 0 {
		v = v[:i] // build metadata does not affect precedence
	}
	var s semver
	if i := strings.IndexByte(v, '-'); i >= 0 {
		v, s.pre = v[:i], v[i+1:]
	}
	parts := strings.Split(v, ".")
	if len(parts) == 0 || len(parts) > 3 {
		return s, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return s, false
		}
		s.nums[i] = n
	}
	return s, true
}
