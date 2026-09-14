package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"juku/internal/app"
)

//go:embed all:frontend/dist
var embedded embed.FS

const (
	appTitle       = "果果剧库"
	singleInstance = "juku-hongguo-desktop-9b1f6c2e"
	shutdownWait   = 8 * time.Second
)

// desktop 把内置 HTTP 服务的生命周期绑定到窗口：窗口就绪后启动服务，窗口关闭时停止服务。
type desktop struct {
	opts app.DesktopOptions

	mu       sync.Mutex
	ctx      context.Context
	server   *app.DesktopServer
	startErr error
	quitting bool
	windows  *windowManager
}

func main() {
	d := &desktop{}
	child := &childWindow{}
	parseFlags(&d.opts, child)
	d.opts.FFmpegBundle = ffmpegBundle()

	assets, err := fs.Sub(embedded, "frontend/dist")
	if err != nil {
		fmt.Fprintln(os.Stderr, "内嵌页面丢失:", err)
		os.Exit(1)
	}
	// 以 -window 启动的是独立播放窗口：只开窗口加载已运行服务的页面，不启动服务
	if child.active() {
		child.dataDir = d.opts.DataDir
		if err := runChildWindow(child, assets); err != nil {
			fmt.Fprintln(os.Stderr, "独立窗口启动失败:", err)
			os.Exit(1)
		}
		return
	}
	d.windows = newWindowManager(d.opts.DataDir)

	err = wails.Run(&options.App{
		Title:            appTitle,
		Width:            1280,
		Height:           840,
		MinWidth:         900,
		MinHeight:        600,
		BackgroundColour: &options.RGBA{R: 245, G: 247, B: 251, A: 1},
		AssetServer: &assetserver.Options{
			Assets:  assets,
			Handler: http.HandlerFunc(d.handleStatus),
		},
		OnStartup:  d.startup,
		OnShutdown: d.shutdown,
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId:               singleInstance,
			OnSecondInstanceLaunch: d.focus,
		},
		Windows: &windows.Options{
			Theme:                windows.SystemDefault,
			IsZoomControlEnabled: true,
			WebviewUserDataPath:  webviewDataPath(d.opts.DataDir),
		},
		Mac: &mac.Options{
			TitleBar: mac.TitleBarDefault(),
			About:    &mac.AboutInfo{Title: appTitle, Message: "红果短剧本地点播与下载工具"},
		},
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "窗口启动失败:", err)
		os.Exit(1)
	}
}

func parseFlags(opts *app.DesktopOptions, child *childWindow) {
	set := flag.NewFlagSet(filepath.Base(os.Args[0]), flag.ContinueOnError)
	child.register(set)
	set.StringVar(&opts.Listen, "listen", "", "监听地址；默认只监听本机随机端口，填 0.0.0.0:8999 可供局域网访问")
	set.StringVar(&opts.DataDir, "data-dir", "", "配置、缓存和任务目录，默认为程序目录下的 data")
	set.StringVar(&opts.OutputDir, "out", "", "视频下载目录，默认沿用配置或“短剧下载”")
	set.StringVar(&opts.FFmpeg, "ffmpeg", "", "FFmpeg 路径，默认自动查找或下载便携版")
	set.StringVar(&opts.ConfigFile, "config", "", "首次运行时导入旧版配置文件")
	// 桌面程序通常没有控制台，参数错误时只忽略未知参数，不退出。
	_ = set.Parse(os.Args[1:])
}

// webviewDataPath 把 WebView2 的缓存放进数据目录，保证程序目录整体可搬迁。
func webviewDataPath(dataDir string) string {
	if dataDir == "" {
		return ""
	}
	if absolute, err := filepath.Abs(dataDir); err == nil {
		return filepath.Join(absolute, "webview2")
	}
	return ""
}

func (d *desktop) startup(ctx context.Context) {
	d.mu.Lock()
	d.ctx = ctx
	d.mu.Unlock()
	go d.startServer(ctx)
}

func (d *desktop) startServer(ctx context.Context) {
	server, err := app.StartDesktopServer(d.opts)
	if err == nil {
		// 页面通过这个入口请求再开一个原生播放窗口
		server.SetWindowOpener(d.windows.open)
	}
	d.mu.Lock()
	d.server, d.startErr = server, err
	d.mu.Unlock()
	if err != nil {
		return
	}
	// 服务意外退出时提示并退出，避免窗口里只剩一个无法连接的空页。
	serveErr := <-server.Done()
	d.mu.Lock()
	quitting := d.quitting
	d.mu.Unlock()
	if quitting || serveErr == nil || errors.Is(serveErr, http.ErrServerClosed) {
		return
	}
	_, _ = runtime.MessageDialog(ctx, runtime.MessageDialogOptions{
		Type:    runtime.ErrorDialog,
		Title:   appTitle,
		Message: "内置服务已停止：" + serveErr.Error(),
	})
	runtime.Quit(ctx)
}

func (d *desktop) shutdown(context.Context) {
	d.mu.Lock()
	d.quitting = true
	server := d.server
	d.mu.Unlock()
	// 子窗口离开主进程后无法工作，先一并结束
	d.windows.closeAll()
	if server == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), shutdownWait)
	defer cancel()
	_ = server.Close(ctx)
}

func (d *desktop) focus(options.SecondInstanceData) {
	d.mu.Lock()
	ctx := d.ctx
	d.mu.Unlock()
	if ctx == nil {
		return
	}
	runtime.WindowUnminimise(ctx)
	runtime.Show(ctx)
}

// handleStatus 处理内嵌页面之外的请求：/desktop/status 报告内置服务是否就绪。
func (d *desktop) handleStatus(w http.ResponseWriter, r *http.Request) {
	if strings.TrimSuffix(r.URL.Path, "/") != "/desktop/status" {
		http.NotFound(w, r)
		return
	}
	d.mu.Lock()
	server, err := d.server, d.startErr
	d.mu.Unlock()
	status := map[string]any{"ready": false}
	switch {
	case err != nil:
		status["error"] = err.Error()
	case server != nil:
		status["ready"] = true
		status["url"] = server.URL()
		status["address"] = server.Address()
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(status)
}
