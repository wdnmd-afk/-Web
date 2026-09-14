//go:build !windows

package main

import "juku/internal/app"

// 非 Windows 平台暂不内置 FFmpeg，沿用首次运行自动下载。
func ffmpegBundle() *app.FFmpegBundle { return nil }
