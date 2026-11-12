//go:build windows

package selfupdate

// Relaunch is a no-op on Windows: the downloaded installer opens the new
// version once it has replaced the files.
func Relaunch([]string) error { return nil }
