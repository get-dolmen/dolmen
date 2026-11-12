//go:build darwin || linux

package selfupdate

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
)

// Relaunch starts argv once this process has exited. A detached shell waits
// for the current PID, so the old and new versions never run together.
func Relaunch(argv []string) error {
	if len(argv) == 0 {
		return nil
	}
	script := fmt.Sprintf("while kill -0 %d 2>/dev/null; do sleep 0.2; done; exec %s", os.Getpid(), shellQuote(argv))
	cmd := exec.Command("/bin/sh", "-c", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

func shellQuote(argv []string) string {
	quoted := make([]string, len(argv))
	for i, arg := range argv {
		quoted[i] = "'" + strings.ReplaceAll(arg, "'", `'\''`) + "'"
	}
	return strings.Join(quoted, " ")
}
