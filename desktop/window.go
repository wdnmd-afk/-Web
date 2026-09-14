package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"juku/internal/app"
)

// Wails v2 一个进程只有一个窗口。独立播放窗口的做法是：主进程用 -window 参数再启动一次自己，
// 子进程只开一个窗口去加载已经在运行的本机服务页面，不再启动服务，也不占单实例锁。
// 子进程共用同一个 WebView2 数据目录，音量、清晰度等偏好与主窗口一致；主进程退出时结束全部子窗口。

// childWindow 是子窗口模式的启动参数与关闭状态。
type childWindow struct {
	url     string
	title   string
	width   int
	height  int
	mini    bool
	dataDir string

	closing  atomic.Bool
	shutdown atomic.Bool
}

const (
	childWindowMinWidth  = 640
	childWindowMinHeight = 480
	childMiniMinWidth    = 300
	childMiniMinHeight   = 420
	childCloseGrace      = 1500 * time.Millisecond
	childCloseWait       = 2500 * time.Millisecond
	parentPollInterval   = 3 * time.Second
	parentPollFailures   = 3
)

// register 把子窗口参数挂到主程序的参数集合上，主程序与子进程共用同一套解析。
func (c *childWindow) register(set *flag.FlagSet) {
	set.StringVar(&c.url, "window", "", "以独立窗口模式打开指定页面（由主程序内部使用）")
	set.StringVar(&c.title, "window-title", appTitle, "独立窗口标题")
	set.IntVar(&c.width, "window-width", 0, "独立窗口宽度")
	set.IntVar(&c.height, "window-height", 0, "独立窗口高度")
	set.BoolVar(&c.mini, "window-mini", false, "独立窗口按小窗尺寸限制")
}

func (c *childWindow) active() bool { return strings.TrimSpace(c.url) != "" }

// origin 返回页面来源（协议 + 主机），用于放行 Wails 运行时调用和探测主进程。
func (c *childWindow) origin() (string, error) {
	target, err := url.Parse(c.url)
	if err != nil || target.Scheme == "" || target.Host == "" {
		return "", fmt.Errorf("独立窗口地址无效: %q", c.url)
	}
	return target.Scheme + "://" + target.Host, nil
}

// runChildWindow 以子窗口模式运行：窗口就绪后启动页立刻跳转到目标地址。
func runChildWindow(c *childWindow, assets fs.FS) error {
	origin, err := c.origin()
	if err != nil {
		return err
	}
	width, height := c.width, c.height
	minWidth, minHeight := childWindowMinWidth, childWindowMinHeight
	if c.mini {
		minWidth, minHeight = childMiniMinWidth, childMiniMinHeight
	}
	if width <= 0 {
		width = 1100
	}
	if height <= 0 {
		height = 760
	}
	if width < minWidth {
		width = minWidth
	}
	if height < minHeight {
		height = minHeight
	}
	title := strings.TrimSpace(c.title)
	if title == "" {
		title = appTitle
	}
	// 小窗画面铺满窗口，底色用剧场的深色；普通播放窗口沿用主窗口的浅色，避免加载时闪一下
	background := &options.RGBA{R: 245, G: 247, B: 251, A: 1}
	if c.mini {
		background = &options.RGBA{R: 11, G: 15, B: 22, A: 1}
	}
	return wails.Run(&options.App{
		Title:            title,
		Width:            width,
		Height:           height,
		MinWidth:         minWidth,
		MinHeight:        minHeight,
		BackgroundColour: background,
		AssetServer: &assetserver.Options{
			Assets:  assets,
			Handler: http.HandlerFunc(c.handleStatus),
		},
		// 页面来自本机服务而不是内嵌资源，放行它的来源后页面才能调用退出、置顶、改标题
		BindingsAllowedOrigins: origin,
		OnStartup: func(ctx context.Context) {
			// 页面在自动播放被拦下时请求宿主代点一下画面，见 activateWebView
			runtime.EventsOn(ctx, "juku:activate", handleActivate)
			go watchParent(ctx, origin, &c.shutdown)
		},
		OnBeforeClose: c.beforeClose,
		OnShutdown:    func(context.Context) { c.shutdown.Store(true) },
		Windows: &windows.Options{
			Theme:                windows.SystemDefault,
			IsZoomControlEnabled: true,
			WebviewUserDataPath:  webviewDataPath(c.dataDir),
		},
		Mac: &mac.Options{
			TitleBar: mac.TitleBarDefault(),
		},
	})
}

// handleActivate 解析页面给出的画面中心坐标并投递点击；失败不影响播放，用户仍可自己点画面。
func handleActivate(args ...interface{}) {
	if len(args) == 0 {
		return
	}
	point, _ := args[0].(map[string]interface{})
	x, _ := point["x"].(float64)
	y, _ := point["y"].(float64)
	if x <= 0 || y <= 0 {
		return
	}
	_ = activateWebView(int(x), int(y))
}

// beforeClose 在用户点标题栏关闭时先让页面收尾（上报进度、释放播放会话），页面完成后再调用
// 运行时的 Quit 真正退出；页面没有响应时到时兜底退出。
func (c *childWindow) beforeClose(ctx context.Context) bool {
	if c.closing.Swap(true) {
		return false
	}
	runtime.EventsEmit(ctx, "juku:closing")
	time.AfterFunc(childCloseGrace, func() {
		if !c.shutdown.Load() {
			runtime.Quit(ctx)
		}
	})
	return true
}

// pageURL 给页面地址加上 wails=1 标记：页面据此从内嵌资源加载 Wails 运行时，退出、置顶、改标题都要靠它。
func (c *childWindow) pageURL() string {
	target, err := url.Parse(c.url)
	if err != nil {
		return c.url
	}
	query := target.Query()
	query.Set("wails", "1")
	target.RawQuery = query.Encode()
	return target.String()
}

// handleStatus 复用主程序的启动页：子窗口没有服务要等，直接报告就绪并给出目标地址。
func (c *childWindow) handleStatus(w http.ResponseWriter, r *http.Request) {
	if strings.TrimSuffix(r.URL.Path, "/") != "/desktop/status" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{"ready": true, "url": c.pageURL()})
}

// watchParent 定期探测主进程的服务。主进程退出后页面已无法工作，子窗口随之关闭。
// 正常情况下主进程退出时会主动结束子进程，这里是主进程异常消失时的兜底。
func watchParent(ctx context.Context, origin string, shutdown *atomic.Bool) {
	client := &http.Client{Timeout: parentPollInterval, Transport: &http.Transport{Proxy: nil}}
	ticker := time.NewTicker(parentPollInterval)
	defer ticker.Stop()
	failures := 0
	for range ticker.C {
		if shutdown.Load() {
			return
		}
		response, err := client.Get(origin + "/api/ui/desktop")
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode < http.StatusInternalServerError {
				failures = 0
				continue
			}
		}
		failures++
		if failures >= parentPollFailures {
			runtime.Quit(ctx)
			return
		}
	}
}

// windowManager 在主进程里创建和结束子窗口进程。
type windowManager struct {
	dataDir string

	mu     sync.Mutex
	procs  map[int]*exec.Cmd
	closed bool
}

func newWindowManager(dataDir string) *windowManager {
	return &windowManager{dataDir: dataDir, procs: make(map[int]*exec.Cmd)}
}

// open 启动一个子窗口进程。参数已由服务端校验过：地址只会是本机服务自己的页面。
func (m *windowManager) open(request app.DesktopWindowRequest) error {
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("定位程序文件失败: %w", err)
	}
	args := []string{
		"-window", request.URL,
		"-window-title", request.Title,
		"-window-width", strconv.Itoa(request.Width),
		"-window-height", strconv.Itoa(request.Height),
	}
	if request.Mini {
		args = append(args, "-window-mini")
	}
	if m.dataDir != "" {
		args = append(args, "-data-dir", m.dataDir)
	}
	command := exec.Command(executable, args...)
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return errors.New("程序正在退出")
	}
	if err := command.Start(); err != nil {
		return fmt.Errorf("启动窗口进程失败: %w", err)
	}
	pid := command.Process.Pid
	m.procs[pid] = command
	go func() {
		_ = command.Wait()
		m.mu.Lock()
		delete(m.procs, pid)
		m.mu.Unlock()
	}()
	return nil
}

// closeAll 结束所有子窗口，主窗口关闭时调用。先请求正常关闭，让子窗口来得及上报进度、
// 释放播放会话；超时仍未退出的再强制结束。
func (m *windowManager) closeAll() {
	m.mu.Lock()
	m.closed = true
	procs := make([]*exec.Cmd, 0, len(m.procs))
	for _, command := range m.procs {
		procs = append(procs, command)
	}
	m.mu.Unlock()
	if len(procs) == 0 {
		return
	}
	for _, command := range procs {
		if command.Process != nil {
			requestWindowClose(command.Process.Pid)
		}
	}
	deadline := time.Now().Add(childCloseWait)
	for time.Now().Before(deadline) {
		m.mu.Lock()
		remaining := len(m.procs)
		m.mu.Unlock()
		if remaining == 0 {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, command := range m.procs {
		if command.Process != nil {
			_ = command.Process.Kill()
		}
	}
}
