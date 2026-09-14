//go:build !windows

package app

import "os/exec"

// hideConsoleWindow 仅在 Windows 上需要隐藏子进程控制台，其他平台无操作。
func hideConsoleWindow(*exec.Cmd) {}
