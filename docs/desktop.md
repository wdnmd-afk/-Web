# 桌面版说明

桌面版把原有的本地 Web 界面装进一个原生窗口，双击即可使用，不需要浏览器、命令行或额外安装。Windows 使用系统自带的 WebView2，macOS 使用 WKWebView，产物是单个可执行文件。

## 使用

1. 把 `dist/果果剧库.exe` 放到任意可写目录（桌面、D 盘文件夹或 U 盘均可）。
2. 双击启动。首次运行会在同目录生成 `data/`（配置、剧库缓存、任务状态）和 `短剧下载/`（视频），与浏览器版规则一致，可直接复用旧目录。
3. 关闭窗口即退出：正在下载的分集会被中断并放回队列，下次打开自动续传；点播转码进程随窗口一起结束。
4. 重复双击不会打开第二个窗口，只会把已有窗口调到前台。

未安装 WebView2 运行库的老系统会在首次启动时提示下载安装；Windows 11 已内置，Windows 10 多数已通过系统更新安装。

Windows 桌面版内置了 FFmpeg（与自动下载相同的 eugeneware/ffmpeg-static b6.1.1 构建，含许可与说明文件），首次启动约两秒内释放到程序旁的 `bin\windows-amd64\`，之后封面、播放和下载无需联网下载任何组件；因此 exe 约 42 MB。已有可用 FFmpeg 时不会覆盖。释放失败会回退到原来的联网自动下载，顶栏会显示 FFmpeg 准备进度或失败原因。代理、目录选择等功能与浏览器版完全相同。

## 与浏览器版的区别

- 桌面版只监听本机随机端口，界面地址不对局域网开放。需要局域网访问时请继续使用 `juku_windows_amd64.exe`，或用命令行启动桌面版：`果果剧库.exe -listen 0.0.0.0:8999`。
- 桌面版没有控制台输出，启动失败会直接显示在窗口里。
- 其余命令行参数与浏览器版相同：`-data-dir`、`-out`、`-ffmpeg`、`-config`。
- WebView2 的页面缓存位于 `%APPDATA%\果果剧库`，不影响 `data/` 的可搬迁性。

## 工作原理

`desktop/main.go` 是 Wails v2 入口。窗口就绪后调用 `app.StartDesktopServer` 在 `127.0.0.1:0` 上启动与命令行版完全相同的 HTTP 服务，窗口先加载内嵌的启动页，启动页轮询 `/desktop/status` 拿到地址后跳转到本机服务。之后所有页面、接口、点播流量都走同一个本机端口，与浏览器打开时没有差别；窗口关闭时调用 `UIApp.Shutdown` 优雅停止。

不通过 Wails 的资源服务器转发接口，是为了保证点播时的长连接分块流和播放器跳转与浏览器版行为一致。

## 构建

需要 Go 1.25+，脚本会在缺少时自动安装 Wails CLI v2.16。Windows 构建脚本还会把内置 FFmpeg 的三个文件下载到 `desktop/ffmpeg/`（不入库，约 28 MB，只需下载一次），由 `desktop/bundle_windows.go` 通过 `go:embed` 打进程序；构建机需要能访问 GitHub Releases。

- Windows：项目根目录执行 `scripts\build-desktop.bat`，生成 `dist\果果剧库.exe`。
- macOS / Linux：`./scripts/build-desktop.sh`，生成 `dist/果果剧库.app` 或 `dist/果果剧库`。macOS 需要 Xcode 命令行工具，Linux 需要 `libgtk-3-dev` 与 `libwebkit2gtk-4.0-dev`。macOS 与 Linux 尚未实机验证。

也可以直接使用 Go 工具链构建 Windows 版，不带图标和版本信息：

```bash
go build -tags desktop,production -trimpath -ldflags "-s -w -H windowsgui" -o dist/果果剧库.exe ./desktop
```

`desktop/build/appicon.png` 是应用图标源文件，`wails build` 会据此生成 `icon.ico` 并写入可执行文件。修改页面仍然在 `internal/webui/`，桌面版和浏览器版共用，无需改动 `desktop/`。
