package main

import (
	_ "embed"

	"juku/internal/app"
)

// Windows 桌面版内置 FFmpeg（与自动下载的 eugeneware/ffmpeg-static b6.1.1 相同），
// 首次启动释放到 bin/windows-amd64，对方电脑无需联网下载。
// 文件由 scripts/build-desktop.bat 在缺少时自动下载到 desktop/ffmpeg/。

//go:embed ffmpeg/ffmpeg-win32-x64.gz
var ffmpegArchive []byte

//go:embed ffmpeg/win32-x64.LICENSE
var ffmpegLicense []byte

//go:embed ffmpeg/win32-x64.README
var ffmpegReadme []byte

func ffmpegBundle() *app.FFmpegBundle {
	return &app.FFmpegBundle{Archive: ffmpegArchive, License: ffmpegLicense, Readme: ffmpegReadme}
}
