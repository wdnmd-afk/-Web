//go:build windows

package main

import (
	"errors"
	"os"
	"sync"
	"syscall"
	"unsafe"
)

var (
	user32                       = syscall.NewLazyDLL("user32.dll")
	procEnumWindows              = user32.NewProc("EnumWindows")
	procGetWindowThreadProcessId = user32.NewProc("GetWindowThreadProcessId")
	procIsWindowVisible          = user32.NewProc("IsWindowVisible")
	procFindWindowExW            = user32.NewProc("FindWindowExW")
	procPostMessageW             = user32.NewProc("PostMessageW")
)

const (
	wmClose       = 0x0010
	wmLButtonDown = 0x0201
	wmLButtonUp   = 0x0202
	mkLButton     = 0x0001
)

// activateWebView 向本进程窗口里的 WebView2 投递一次鼠标点击，坐标为客户区物理像素。
// 新窗口没有用户操作记录，浏览器不允许自动出声播放；页面在“点击画面开始播放”状态下请求这一下，
// 由宿主代替用户点在画面上，页面里的点击处理随即开始播放。只投递给自己的窗口，不移动鼠标指针。
func activateWebView(x, y int) error {
	owners := windowsOfProcess(uint32(os.Getpid()))
	if len(owners) == 0 {
		return errors.New("找不到本进程的窗口")
	}
	className, err := syscall.UTF16PtrFromString("Chrome_WidgetWin_0")
	if err != nil {
		return err
	}
	target, _, _ := procFindWindowExW.Call(owners[0], 0, uintptr(unsafe.Pointer(className)), 0)
	if target == 0 {
		return errors.New("找不到 WebView2 窗口")
	}
	position := uintptr(uint32(uint16(y))<<16 | uint32(uint16(x)))
	if ok, _, callErr := procPostMessageW.Call(target, wmLButtonDown, mkLButton, position); ok == 0 {
		return callErr
	}
	_, _, _ = procPostMessageW.Call(target, wmLButtonUp, 0, position)
	return nil
}

// requestWindowClose 请求子窗口进程正常关闭：等同用户点了标题栏的关闭按钮，
// 子窗口会先上报进度、释放播放会话再退出。返回 false 表示没有找到窗口。
func requestWindowClose(pid int) bool {
	windows := windowsOfProcess(uint32(pid))
	for _, hwnd := range windows {
		_, _, _ = procPostMessageW.Call(hwnd, wmClose, 0, 0)
	}
	return len(windows) > 0
}

// 枚举回调只创建一次：syscall.NewCallback 的数量有限，不能每次调用都新建。
var (
	enumMu       sync.Mutex
	enumFound    []uintptr
	enumPid      uint32
	enumCallback = syscall.NewCallback(func(hwnd uintptr, _ uintptr) uintptr {
		var pid uint32
		_, _, _ = procGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
		if pid != enumPid {
			return 1
		}
		if visible, _, _ := procIsWindowVisible.Call(hwnd); visible == 0 {
			return 1
		}
		enumFound = append(enumFound, hwnd)
		return 1
	})
)

// windowsOfProcess 返回某进程所有可见的顶层窗口。
func windowsOfProcess(pid uint32) []uintptr {
	enumMu.Lock()
	defer enumMu.Unlock()
	enumFound = nil
	enumPid = pid
	_, _, _ = procEnumWindows.Call(enumCallback, 0)
	return append([]uintptr(nil), enumFound...)
}
