//go:build !windows

package main

import "errors"

// activateWebView 仅在 Windows 上实现；其他平台的子窗口需要用户自己点一下画面开始播放。
func activateWebView(int, int) error {
	return errors.New("当前平台不支持代点画面")
}

// requestWindowClose 仅在 Windows 上实现；其他平台直接结束子窗口进程。
func requestWindowClose(int) bool {
	return false
}
