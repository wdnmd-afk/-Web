#!/usr/bin/env bash
# 构建当前系统的桌面版（Wails v2）。Windows 请使用 scripts\build-desktop.bat。
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
mkdir -p dist

if ! command -v wails >/dev/null 2>&1; then
  echo "未找到 wails 命令，正在安装 Wails CLI..."
  go install github.com/wailsapp/wails/v2/cmd/wails@v2.16.0
  export PATH="$PATH:$(go env GOPATH)/bin"
fi

case "$(uname -s)" in
  Darwin)
    arch="$(uname -m)"
    [ "$arch" = "x86_64" ] && platform="darwin/amd64" || platform="darwin/arm64"
    (cd desktop && wails build -clean -platform "$platform" -trimpath -ldflags "-s -w")
    rm -rf "dist/果果剧库.app"
    cp -R "desktop/build/bin/果果剧库.app" dist/
    echo "已生成 dist/果果剧库.app"
    ;;
  Linux)
    (cd desktop && wails build -clean -platform linux/amd64 -trimpath -ldflags "-s -w")
    cp "desktop/build/bin/果果剧库" "dist/果果剧库"
    echo "已生成 dist/果果剧库（需要 webkit2gtk 运行库）"
    ;;
  *)
    echo "请在 Windows 上运行 scripts\\build-desktop.bat" >&2
    exit 1
    ;;
esac
