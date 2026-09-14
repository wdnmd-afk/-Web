package app

import (
	"net/http"
	"net/url"
	"strings"
)

// DesktopWindowRequest 是页面请求桌面壳打开独立播放窗口时的参数。
type DesktopWindowRequest struct {
	// URL 为窗口要加载的页面，只允许本程序自己的地址。
	URL string `json:"url"`
	// Title 为窗口初始标题，之后页面可自行更新。
	Title string `json:"title"`
	// Width、Height 为窗口初始大小，像素；为零时按 Mini 取默认值。
	Width  int  `json:"width"`
	Height int  `json:"height"`
	Mini   bool `json:"mini"`
}

// 独立窗口的默认与极限尺寸。小窗按竖屏短剧比例给一个紧凑的默认值。
const (
	desktopWindowDefaultWidth  = 1100
	desktopWindowDefaultHeight = 760
	desktopMiniDefaultWidth    = 380
	desktopMiniDefaultHeight   = 700
	desktopWindowMinSize       = 240
	desktopWindowMaxSize       = 8192
	desktopWindowTitleLimit    = 120
)

// SetWindowOpener 注册“打开原生子窗口”的实现，由桌面壳在服务启动后调用。
// 浏览器版没有实现，页面会退回 window.open 弹出窗口。
func (s *DesktopServer) SetWindowOpener(open func(DesktopWindowRequest) error) {
	s.app.setWindowOpener(open)
}

func (a *UIApp) setWindowOpener(open func(DesktopWindowRequest) error) {
	a.windowMu.Lock()
	a.windowOpener = open
	a.windowMu.Unlock()
}

func (a *UIApp) windowOpenerFunc() func(DesktopWindowRequest) error {
	a.windowMu.Lock()
	defer a.windowMu.Unlock()
	return a.windowOpener
}

func (a *UIApp) registerDesktopRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/ui/desktop", a.handleDesktop)
	mux.HandleFunc("/api/ui/desktop/window", a.handleDesktopWindow)
}

// handleDesktop 报告桌面壳能力，页面据此决定用原生子窗口还是浏览器弹窗；
// 子窗口也用它探测主程序是否还在运行。
func (a *UIApp) handleDesktop(writer http.ResponseWriter, request *http.Request) {
	if !playbackRequestAllowed(writer, request, http.MethodGet) {
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"windows": a.windowOpenerFunc() != nil})
}

// handleDesktopWindow 让桌面壳再开一个原生窗口。只接受同源页面的请求，
// 且目标必须是本服务自己的首页，避免被用来打开任意地址。
func (a *UIApp) handleDesktopWindow(writer http.ResponseWriter, request *http.Request) {
	var input DesktopWindowRequest
	if !readPlaybackRequest(writer, request, &input) {
		return
	}
	open := a.windowOpenerFunc()
	if open == nil {
		writeJSON(writer, http.StatusNotFound, map[string]string{"error": "当前不是桌面版，无法打开原生窗口"})
		return
	}
	target, err := url.Parse(strings.TrimSpace(input.URL))
	if err != nil || target.Scheme != "http" || target.User != nil || !strings.EqualFold(target.Host, request.Host) || (target.Path != "" && target.Path != "/") {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "只能打开本程序自己的页面"})
		return
	}
	input.URL = target.String()
	input.Title = strings.TrimSpace(input.Title)
	if input.Title == "" {
		input.Title = "果果剧库"
	}
	if runes := []rune(input.Title); len(runes) > desktopWindowTitleLimit {
		input.Title = string(runes[:desktopWindowTitleLimit])
	}
	defaultWidth, defaultHeight := desktopWindowDefaultWidth, desktopWindowDefaultHeight
	if input.Mini {
		defaultWidth, defaultHeight = desktopMiniDefaultWidth, desktopMiniDefaultHeight
	}
	input.Width = clampWindowSize(input.Width, defaultWidth)
	input.Height = clampWindowSize(input.Height, defaultHeight)
	if err := open(input); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]string{"error": "打开窗口失败：" + err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"ok": true})
}

func clampWindowSize(value, fallback int) int {
	switch {
	case value <= 0:
		return fallback
	case value < desktopWindowMinSize:
		return desktopWindowMinSize
	case value > desktopWindowMaxSize:
		return desktopWindowMaxSize
	}
	return value
}
