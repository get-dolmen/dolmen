//go:build !darwin && !linux && !windows

package selfupdate

import "errors"

func installArchive(string) (Outcome, error) {
	return Outcome{}, errors.New("in-place updates are not available on this platform")
}
