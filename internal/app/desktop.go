package app

import (
	"context"
	"fmt"
	"net"
	"os"
	"strings"
)

// DesktopOptions 控制桌面壳启动内置服务的方式。字段为空时使用与命令行版相同的默认值。
type DesktopOptions struct {
	// DataDir 为配置、缓存和任务目录；为空时使用程序目录下的 data。
	DataDir string
	// OutputDir 为视频下载目录；为空时沿用配置文件或默认的“短剧下载”。
	OutputDir string
	// Listen 为监听地址；为空时只监听本机随机端口，填 0.0.0.0:8999 等可开放局域网访问。
	Listen string
	// ConfigFile 为首次运行时导入的旧版配置文件，可选。
	ConfigFile string
	// FFmpeg 为 FFmpeg 路径覆盖，可选。
	FFmpeg string
	// FFmpegBundle 为随程序内置的 FFmpeg 安装包；首次启动释放到 bin 目录，之后无需联网下载。
	FFmpegBundle *FFmpegBundle
}

// DesktopServer 是嵌入桌面窗口的管理界面服务：启动后窗口加载 URL()，关闭窗口时调用 Close。
type DesktopServer struct {
	app      *UIApp
	listener net.Listener
	url      string
	done     chan error
}

// StartDesktopServer 按命令行版的流程初始化配置与下载器，在本机端口上启动管理界面并立即返回。
func StartDesktopServer(opts DesktopOptions) (*DesktopServer, error) {
	if opts.DataDir == "" && opts.ConfigFile == "" {
		if err := preparePortableWorkingDirectory(); err != nil {
			return nil, fmt.Errorf("初始化程序目录失败: %w", err)
		}
	}
	cfg, err := loadApplicationConfig(firstNonEmpty(opts.DataDir, "data"), opts.ConfigFile, opts.OutputDir)
	if err != nil {
		return nil, fmt.Errorf("初始化配置失败: %w", publicError(err))
	}
	if opts.FFmpeg != "" {
		cfg.FFmpeg = opts.FFmpeg
	}
	if err := cfg.validate(); err != nil {
		return nil, fmt.Errorf("配置错误: %w", err)
	}
	downloader := NewDownloader(cfg)
	cfg = downloader.cfg
	if err := os.MkdirAll(cfg.OutputDir, 0o755); err != nil {
		return nil, fmt.Errorf("创建输出目录失败: %w", err)
	}
	// 内置 FFmpeg 在后台释放，不阻塞窗口显示；失败时回退到自动下载。
	downloader.ffmpegInstallation().seed(opts.FFmpegBundle)

	addr := "127.0.0.1:0"
	if strings.TrimSpace(opts.Listen) != "" {
		addr = normalizeListen(opts.Listen)
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("监听 %s 失败: %w", addr, err)
	}

	server := &DesktopServer{
		app:      NewUIApp(downloader),
		listener: listener,
		url:      publicURL(listener.Addr().String()),
		done:     make(chan error, 1),
	}
	go func() {
		server.done <- server.app.Serve(listener)
	}()
	return server, nil
}

// URL 返回本机可访问的管理界面地址。
func (s *DesktopServer) URL() string { return s.url }

// Address 返回实际监听地址，供界面提示局域网访问方式。
func (s *DesktopServer) Address() string { return s.listener.Addr().String() }

// Done 在服务停止后收到结果；正常关闭时为 http.ErrServerClosed。
func (s *DesktopServer) Done() <-chan error { return s.done }

// Close 优雅停止服务，等待时间由 ctx 控制。
func (s *DesktopServer) Close(ctx context.Context) error {
	return s.app.Shutdown(ctx)
}
