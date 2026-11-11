package main

import "testing"

func TestNewerVersion(t *testing.T) {
	cases := []struct {
		candidate, current string
		want               bool
	}{
		{"v1.2.0", "v1.1.9", true},
		{"v1.2.0", "1.2.0", false},
		{"v1.10.0", "v1.9.3", true},
		{"v2.0.0", "v10.0.0", false},
		{"v1.2.0", "v1.2.0-rc.1", true},
		{"v1.2.0-rc.2", "v1.2.0-rc.1", true},
		{"v1.2.0-rc.1", "v1.2.0", false},
		{"v1.2", "v1.1.5", true},
		{"v0.1.0", "dev", true},
		{"v0.1.0", "0.0.0-dev+abc123", true},
		{"nightly", "v1.0.0", false},
		{"v1.0.0+build.5", "v1.0.0", false},
	}
	for _, c := range cases {
		if got := newerVersion(c.candidate, c.current); got != c.want {
			t.Errorf("newerVersion(%q, %q) = %v, want %v", c.candidate, c.current, got, c.want)
		}
	}
}
