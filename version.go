package main

import (
	"strconv"
	"strings"
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
