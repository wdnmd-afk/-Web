package app

import (
	"os/exec"
	"syscall"
)

// hideConsoleWindow 让 FFmpeg、reg 等命令行子进程不弹出控制台窗口。
// 桌面版没有自己的控制台，否则 Windows 会为每个子进程新开一个黑框。
func hideConsoleWindow(command *exec.Cmd) {
	if command.SysProcAttr == nil {
		command.SysProcAttr = &syscall.SysProcAttr{}
	}
	command.SysProcAttr.HideWindow = true
	command.SysProcAttr.CreationFlags |= 0x08000000 // CREATE_NO_WINDOW
}
