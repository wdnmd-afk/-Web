package app

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// 用桌面版内置的安装包验证 seed 能把 FFmpeg 释放到 bin 目录。
func TestFFmpegSeedFromBundle(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("bundle only prepared for windows")
	}
	root, _ := filepath.Abs("../../desktop/ffmpeg")
	archive, err := os.ReadFile(filepath.Join(root, "ffmpeg-win32-x64.gz"))
	if err != nil {
		t.Skip("bundle not downloaded:", err)
	}
	license, _ := os.ReadFile(filepath.Join(root, "win32-x64.LICENSE"))
	readme, _ := os.ReadFile(filepath.Join(root, "win32-x64.README"))
	dir := t.TempDir()
	installer := &ffmpegInstaller{configured: "ffmpeg-definitely-missing.exe", directory: filepath.Join(dir, "bin", "windows-amd64"), name: "ffmpeg.exe", pack: ffmpegPackages["windows/amd64"], state: ffmpegInstallState{Status: "idle"}}
	<-installer.seed(&FFmpegBundle{Archive: archive, License: license, Readme: readme})
	state := installer.snapshot()
	if state.Status != "ready" || state.Path == "" {
		t.Fatalf("unexpected state: %+v", state)
	}
	if _, err := os.Stat(filepath.Join(installer.directory, "LICENSE.txt")); err != nil {
		t.Fatalf("license missing: %v", err)
	}
}
