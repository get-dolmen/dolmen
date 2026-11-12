//go:build darwin || linux

package selfupdate

import "testing"

func TestShellQuote(t *testing.T) {
	got := shellQuote([]string{"/Applications/Dolmen.app", "it's here"})
	if want := `'/Applications/Dolmen.app' 'it'\''s here'`; got != want {
		t.Errorf("shellQuote = %s, want %s", got, want)
	}
}
