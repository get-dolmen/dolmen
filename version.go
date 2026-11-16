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
	candidateVersion, candidateOK := parseVersion(candidate)
	currentVersion, currentOK := parseVersion(current)
	if !candidateOK {
		return false
	}
	if !currentOK {
		return true
	}
	for index := range 3 {
		if candidateVersion.numbers[index] != currentVersion.numbers[index] {
			return candidateVersion.numbers[index] > currentVersion.numbers[index]
		}
	}
	// 1.2.0 > 1.2.0-rc.1; two pre-releases compare as strings.
	switch {
	case candidateVersion.prerelease == currentVersion.prerelease:
		return false
	case candidateVersion.prerelease == "":
		return true
	case currentVersion.prerelease == "":
		return false
	}
	return candidateVersion.prerelease > currentVersion.prerelease
}

type semver struct {
	numbers    [3]int
	prerelease string
}

func parseVersion(text string) (semver, bool) {
	text = strings.TrimPrefix(strings.TrimSpace(text), "v")
	if index := strings.IndexByte(text, '+'); index >= 0 {
		text = text[:index] // build metadata does not affect precedence
	}
	var parsed semver
	if index := strings.IndexByte(text, '-'); index >= 0 {
		text, parsed.prerelease = text[:index], text[index+1:]
	}
	parts := strings.Split(text, ".")
	if len(parts) == 0 || len(parts) > 3 {
		return parsed, false
	}
	for index, part := range parts {
		number, err := strconv.Atoi(part)
		if err != nil || number < 0 {
			return parsed, false
		}
		parsed.numbers[index] = number
	}
	return parsed, true
}
