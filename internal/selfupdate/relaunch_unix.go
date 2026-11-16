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
func Relaunch(arguments []string) error {
	if len(arguments) == 0 {
		return nil
	}
	script := fmt.Sprintf("while kill -0 %d 2>/dev/null; do sleep 0.2; done; exec %s", os.Getpid(), shellQuote(arguments))
	command := exec.Command("/bin/sh", "-c", script)
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := command.Start(); err != nil {
		return err
	}
	return command.Process.Release()
}

func shellQuote(arguments []string) string {
	quoted := make([]string, len(arguments))
	for index, argument := range arguments {
		quoted[index] = "'" + strings.ReplaceAll(argument, "'", `'\''`) + "'"
	}
	return strings.Join(quoted, " ")
}
