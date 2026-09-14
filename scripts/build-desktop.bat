@echo off
chcp 65001 >nul
cd /d "%~dp0.."
if not exist dist mkdir dist

where wails >nul 2>nul
if errorlevel 1 (
  echo 未找到 wails 命令，正在安装 Wails CLI...
  go install github.com/wailsapp/wails/v2/cmd/wails@v2.16.0
  if errorlevel 1 exit /b 1
  set "PATH=%PATH%;%USERPROFILE%\go\bin"
)

rem 内置 FFmpeg：与自动下载相同的 eugeneware/ffmpeg-static b6.1.1，缺少时下载到 desktop\ffmpeg\
if not exist desktop\ffmpeg mkdir desktop\ffmpeg
for %%f in (ffmpeg-win32-x64.gz win32-x64.LICENSE win32-x64.README) do (
  if not exist "desktop\ffmpeg\%%f" (
    echo 正在下载内置 FFmpeg 组件 %%f ...
    curl -L --retry 3 --fail -o "desktop\ffmpeg\%%f" "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/%%f"
    if errorlevel 1 exit /b 1
  )
)

cd desktop
wails build -clean -platform windows/amd64 -webview2 download -trimpath -ldflags "-s -w"
if errorlevel 1 exit /b 1
cd ..

copy /y "desktop\build\bin\果果剧库.exe" "dist\果果剧库.exe" >nul
if errorlevel 1 exit /b 1
echo 已生成 dist\果果剧库.exe（桌面版，双击即用）
