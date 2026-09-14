package app

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const ffmpegReleaseURL = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/"

type ffmpegPackage struct {
	platform      string
	archiveSize   int64
	binarySize    int64
	archiveSHA256 string
	binarySHA256  string
	licenseSHA256 string
	readmeSHA256  string
}

var ffmpegPackages = map[string]ffmpegPackage{
	"darwin/amd64": {"darwin-x64", 25296431, 78862176,
		"929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106", "ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894",
		"2e1d16c72fd74e12063776371da757322f8b77589386532f4fd8634bde7de1af", "e88a0325f8e5b75210355e37341824f074d3cd82def2125be54c914b62848a36"},
	"darwin/arm64": {"darwin-arm64", 19246198, 45568216,
		"8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa", "a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584",
		"cb48bf09a11f5fb576cddb0431c8f5ed0a60157a9ec942adffc13907cbe083f2", "05ba4b92c96605434b1aaae3eedf5a2c280c9607bf78ffca9a5b536d9af2dc6a"},
	"linux/amd64": {"linux-x64", 29354986, 79826272,
		"bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa", "e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99",
		"8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903", "72f4b1b06d419d22ace6e7cc75f06826f90737345aa0b1736158929f4aacc537"},
	"windows/amd64": {"win32-x64", 29581307, 82797568,
		"8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77", "04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00",
		"8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903", "a636a7183c58006351acbaf35303c0ed85c6e1320fd4e80de453ba6157de6311"},
}

type ffmpegInstallState struct {
	Status          string `json:"status"`
	Detail          string `json:"detail,omitempty"`
	Path            string `json:"path,omitempty"`
	DownloadedBytes int64  `json:"downloadedBytes"`
	TotalBytes      int64  `json:"totalBytes"`
	Error           string `json:"error,omitempty"`
}

type ffmpegInstaller struct {
	mu         sync.Mutex
	configured string
	directory  string
	name       string
	client     *http.Client
	pack       ffmpegPackage
	state      ffmpegInstallState
	done       chan struct{}
	cancel     context.CancelFunc
	lastError  error
	lastTry    time.Time
}

func (downloader *Downloader) ffmpegInstallation() *ffmpegInstaller {
	downloader.ffmpegMu.Lock()
	defer downloader.ffmpegMu.Unlock()
	if downloader.ffmpegInstaller == nil {
		directory, _ := filepath.Abs(filepath.Join("bin", runtime.GOOS+"-"+runtime.GOARCH))
		name := "ffmpeg"
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		client := *downloader.client
		client.Timeout = 0
		client.CheckRedirect = func(request *http.Request, via []*http.Request) error {
			if request.URL.Scheme != "https" || len(via) >= 10 {
				return errors.New("FFmpeg 下载重定向不安全或次数过多")
			}
			return nil
		}
		installer := &ffmpegInstaller{
			configured: downloader.cfg.FFmpeg, directory: directory, name: name, client: &client,
			pack: ffmpegPackages[runtime.GOOS+"/"+runtime.GOARCH], state: ffmpegInstallState{Status: "idle"},
		}
		if path, err := exec.LookPath(portableFFmpeg(installer.configured)); err == nil {
			installer.state = ffmpegInstallState{Status: "ready", Path: path, Detail: "FFmpeg 已就绪"}
		}
		downloader.ffmpegInstaller = installer
	}
	return downloader.ffmpegInstaller
}

func (downloader *Downloader) ensureFFmpeg(ctx context.Context) (string, error) {
	return downloader.ffmpegInstallation().ensure(ctx)
}

func (installer *ffmpegInstaller) snapshot() ffmpegInstallState {
	installer.mu.Lock()
	defer installer.mu.Unlock()
	return installer.state
}

func (installer *ffmpegInstaller) update(status, detail string, downloaded, total int64) {
	installer.mu.Lock()
	installer.state.Status, installer.state.Detail = status, detail
	installer.state.DownloadedBytes, installer.state.TotalBytes = downloaded, total
	installer.mu.Unlock()
}

// errFFmpegPending 表示 FFmpeg 正在后台准备，调用方应快速失败而不是等待。
var errFFmpegPending = errors.New("FFmpeg 正在准备中，请稍后重试")

// locate 返回可用的 FFmpeg 路径；没有时启动后台准备并返回等待通道。
// 调用方持有 installer.mu。
func (installer *ffmpegInstaller) locateLocked() (string, <-chan struct{}, error) {
	if installer.state.Status == "ready" {
		if path, err := exec.LookPath(installer.state.Path); err == nil {
			return path, nil, nil
		}
		installer.state.Status = "idle"
	}
	if installer.done == nil {
		if path, err := exec.LookPath(portableFFmpeg(installer.configured)); err == nil {
			installer.state = ffmpegInstallState{Status: "ready", Path: path, Detail: "FFmpeg 已就绪"}
			return path, nil, nil
		}
		if installer.lastError != nil && time.Since(installer.lastTry) < 30*time.Second {
			return "", nil, installer.lastError
		}
		installer.done = make(chan struct{})
		installer.lastTry = time.Now()
		installer.state = ffmpegInstallState{Status: "downloading", Detail: "未找到 FFmpeg，正在自动准备"}
		installCtx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
		installer.cancel = cancel
		go installer.run(installCtx)
	}
	return "", installer.done, nil
}

// ensure 返回可用的 FFmpeg，必要时等待后台准备完成。
func (installer *ffmpegInstaller) ensure(ctx context.Context) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	installer.mu.Lock()
	path, done, err := installer.locateLocked()
	installer.mu.Unlock()
	if err != nil || done == nil {
		return path, err
	}
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case <-done:
		installer.mu.Lock()
		defer installer.mu.Unlock()
		return installer.state.Path, installer.lastError
	}
}

// tryEnsure 与 ensure 相同，但 FFmpeg 尚未就绪时立即返回 errFFmpegPending，
// 供封面等可稍后重试的请求使用，避免大量请求挂起占满浏览器连接。
func (installer *ffmpegInstaller) tryEnsure() (string, error) {
	installer.mu.Lock()
	defer installer.mu.Unlock()
	path, done, err := installer.locateLocked()
	if err != nil || done == nil {
		return path, err
	}
	return "", errFFmpegPending
}

// FFmpegBundle 是随程序一起分发的 FFmpeg 安装包（与自动下载的文件相同），
// 首次启动时释放到 bin 目录，之后无需联网。
type FFmpegBundle struct {
	Archive []byte
	License []byte
	Readme  []byte
}

// seed 在后台把内置的 FFmpeg 释放到 bin 目录；已有可用 FFmpeg 时不做任何事。
// 释放期间 ensure 会等待、tryEnsure 返回“准备中”，释放失败则回退到自动下载。
// 返回的通道在释放结束后关闭，主要供测试等待。
func (installer *ffmpegInstaller) seed(bundle *FFmpegBundle) <-chan struct{} {
	finished := make(chan struct{})
	if bundle == nil || len(bundle.Archive) == 0 || installer.pack.platform == "" {
		close(finished)
		return finished
	}
	installer.mu.Lock()
	defer installer.mu.Unlock()
	if installer.state.Status == "ready" || installer.done != nil {
		close(finished)
		return finished
	}
	if path, err := exec.LookPath(portableFFmpeg(installer.configured)); err == nil {
		installer.state = ffmpegInstallState{Status: "ready", Path: path, Detail: "FFmpeg 已就绪"}
		close(finished)
		return finished
	}
	installer.state = ffmpegInstallState{Status: "verifying", Detail: "正在释放内置 FFmpeg"}
	installer.done = make(chan struct{})
	go func() {
		defer close(finished)
		path, err := installer.seedInstall(bundle)
		installer.mu.Lock()
		defer installer.mu.Unlock()
		if err != nil {
			fmt.Printf("内置 FFmpeg 释放失败，将尝试自动下载：%v\n", publicError(err))
			installer.state = ffmpegInstallState{Status: "idle", Detail: "内置 FFmpeg 释放失败，将尝试自动下载"}
			installer.lastError = nil
		} else {
			installer.state = ffmpegInstallState{Status: "ready", Path: path, Detail: "FFmpeg 已就绪"}
		}
		close(installer.done)
		installer.done = nil
	}()
	return finished
}

func (installer *ffmpegInstaller) seedInstall(bundle *FFmpegBundle) (string, error) {
	return installer.installFrom(context.Background(), func(ctx context.Context, work string) error {
		binary := filepath.Join(work, installer.name)
		if err := unpackFFmpegReader(bytes.NewReader(bundle.Archive), binary, installer.pack); err != nil {
			return err
		}
		for _, document := range []struct {
			name     string
			body     []byte
			checksum string
		}{{"LICENSE.txt", bundle.License, installer.pack.licenseSHA256}, {"README.txt", bundle.Readme, installer.pack.readmeSHA256}} {
			if sum := sha256.Sum256(document.body); hex.EncodeToString(sum[:]) != document.checksum {
				return errors.New("内置 FFmpeg 许可与说明文件校验失败")
			}
			if err := os.WriteFile(filepath.Join(work, document.name), document.body, 0o644); err != nil {
				return err
			}
		}
		return nil
	})
}

func (installer *ffmpegInstaller) run(ctx context.Context) {
	path, err := installer.install(ctx)
	installer.mu.Lock()
	defer installer.mu.Unlock()
	installer.cancel()
	installer.cancel = nil
	installer.lastError = publicError(err)
	if err != nil {
		installer.state.Status = "failed"
		installer.state.Error = installer.lastError.Error()
		installer.state.Detail = "FFmpeg 自动准备失败，可调整代理后重试"
	} else {
		installer.state = ffmpegInstallState{Status: "ready", Path: path, Detail: "FFmpeg 已就绪"}
	}
	close(installer.done)
	installer.done = nil
}

func (installer *ffmpegInstaller) retry() {
	installer.mu.Lock()
	if installer.done == nil {
		installer.lastError = nil
	}
	installer.mu.Unlock()
}

func (installer *ffmpegInstaller) stop() {
	installer.mu.Lock()
	defer installer.mu.Unlock()
	if installer.cancel != nil {
		installer.cancel()
	}
}

func (installer *ffmpegInstaller) fetch(ctx context.Context, name, target, checksum string, limit int64, progress bool) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, ffmpegReleaseURL+name, nil)
	if err != nil {
		return err
	}
	request.Header.Set("User-Agent", "juku")
	request.Header.Set("Accept-Encoding", "identity")
	response, err := installer.client.Do(request)
	if err != nil {
		return publicError(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("FFmpeg 下载失败：HTTP %d，请检查代理设置后重试", response.StatusCode)
	}
	if response.ContentLength > limit {
		return errors.New("FFmpeg 下载文件超过预期大小")
	}
	file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	digest := sha256.New()
	reader := io.TeeReader(io.LimitReader(response.Body, limit+1), digest)
	var downloaded int64
	buffer := make([]byte, 128*1024)
	lastReport := time.Time{}
	for {
		count, readErr := reader.Read(buffer)
		if count > 0 {
			downloaded += int64(count)
			if downloaded > limit {
				return errors.New("FFmpeg 下载文件超过预期大小")
			}
			if _, err := file.Write(buffer[:count]); err != nil {
				return err
			}
			if progress && time.Since(lastReport) >= 200*time.Millisecond {
				installer.update("downloading", "正在自动下载 FFmpeg", downloaded, installer.pack.archiveSize)
				lastReport = time.Now()
			}
		}
		if readErr != nil {
			if readErr != io.EOF {
				return readErr
			}
			break
		}
	}
	if hex.EncodeToString(digest.Sum(nil)) != checksum {
		return errors.New("FFmpeg 下载文件 SHA-256 校验失败，未安装或执行该文件")
	}
	return file.Close()
}

func unpackFFmpeg(archive, output string, pack ffmpegPackage) error {
	input, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer input.Close()
	return unpackFFmpegReader(input, output, pack)
}

func unpackFFmpegReader(input io.Reader, output string, pack ffmpegPackage) error {
	reader, err := gzip.NewReader(input)
	if err != nil {
		return err
	}
	defer reader.Close()
	file, err := os.OpenFile(output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	digest := sha256.New()
	size, err := io.Copy(io.MultiWriter(file, digest), io.LimitReader(reader, pack.binarySize+1))
	if err != nil {
		return err
	}
	if size != pack.binarySize || hex.EncodeToString(digest.Sum(nil)) != pack.binarySHA256 {
		return errors.New("FFmpeg 可执行文件校验失败，未安装或执行该文件")
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Chmod(output, 0755)
}

func validateFFmpeg(ctx context.Context, path string) error {
	checkCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	command := exec.CommandContext(checkCtx, path, "-hide_banner", "-encoders")
	hideConsoleWindow(command)
	output := &cappedStringWriter{limit: 256 * 1024}
	command.Stdout, command.Stderr = output, output
	if err := command.Run(); err != nil {
		return fmt.Errorf("下载的 FFmpeg 无法在本机启动：%w", err)
	}
	var video, audio bool
	for _, line := range strings.Split(output.String(), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 {
			video = video || fields[1] == "libx264"
			audio = audio || fields[1] == "aac"
		}
	}
	if !video || !audio {
		return errors.New("下载的 FFmpeg 缺少 libx264 或 AAC 编码器，未安装")
	}
	return nil
}

func (installer *ffmpegInstaller) install(ctx context.Context) (string, error) {
	if installer.configured != "" && installer.configured != "ffmpeg" && installer.configured != "ffmpeg.exe" {
		return "", errors.New("指定的 FFmpeg 不可用，请更正 -ffmpeg 路径，或恢复默认 ffmpeg 以启用自动下载")
	}
	if installer.pack.platform == "" {
		return "", fmt.Errorf("暂不支持自动下载 %s/%s 的 FFmpeg，请将对应可执行文件放入 bin 目录", runtime.GOOS, runtime.GOARCH)
	}
	return installer.installFrom(ctx, func(ctx context.Context, work string) error {
		archive := filepath.Join(work, "download.gz")
		pack := installer.pack
		if err := installer.fetch(ctx, "ffmpeg-"+pack.platform+".gz", archive, pack.archiveSHA256, pack.archiveSize, true); err != nil {
			return err
		}
		installer.update("verifying", "正在校验、解压 FFmpeg", pack.archiveSize, pack.archiveSize)
		if err := unpackFFmpeg(archive, filepath.Join(work, installer.name), pack); err != nil {
			return err
		}
		if err := os.Remove(archive); err != nil {
			return err
		}
		for _, document := range []struct{ remote, local, checksum string }{
			{pack.platform + ".LICENSE", "LICENSE.txt", pack.licenseSHA256},
			{pack.platform + ".README", "README.txt", pack.readmeSHA256},
		} {
			if err := installer.fetch(ctx, document.remote, filepath.Join(work, document.local), document.checksum, 256*1024, false); err != nil {
				return fmt.Errorf("下载 FFmpeg 许可与构建说明失败：%w", err)
			}
		}
		return nil
	})
}

// installFrom 在 bin 旁建立临时目录，由 populate 放入 FFmpeg 与许可文件，
// 校验可执行文件后整体移入 bin/<平台> 目录。
func (installer *ffmpegInstaller) installFrom(ctx context.Context, populate func(ctx context.Context, work string) error) (string, error) {
	if err := os.MkdirAll(filepath.Dir(installer.directory), 0755); err != nil {
		return "", fmt.Errorf("无法准备 FFmpeg 目录，请将程序移到可写目录：%w", err)
	}
	work, err := os.MkdirTemp(filepath.Dir(installer.directory), ".ffmpeg-install-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(work)
	if err := populate(ctx, work); err != nil {
		return "", err
	}
	if err := validateFFmpeg(ctx, filepath.Join(work, installer.name)); err != nil {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := moveDirectory(work, installer.directory); err != nil {
		installed := filepath.Join(installer.directory, installer.name)
		if _, lookupErr := exec.LookPath(installed); lookupErr == nil {
			return installed, nil
		}
		return "", fmt.Errorf("保存 FFmpeg 失败，请检查 bin 目录权限或已有文件：%w", err)
	}
	return filepath.Join(installer.directory, installer.name), nil
}

// moveDirectory 把整个目录改名到目标位置。Windows 上刚执行过的可执行文件可能被
// 杀毒软件或系统短暂占用导致改名被拒，因此先重试，仍失败时逐个文件搬过去。
func moveDirectory(source, target string) error {
	var err error
	for attempt := 0; attempt < 10; attempt++ {
		if err = os.Rename(source, target); err == nil {
			return nil
		}
		if _, statErr := os.Stat(target); statErr == nil {
			break
		}
		time.Sleep(time.Duration(200+attempt*150) * time.Millisecond)
	}
	if mkErr := os.MkdirAll(target, 0755); mkErr != nil {
		return err
	}
	entries, readErr := os.ReadDir(source)
	if readErr != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		from, to := filepath.Join(source, entry.Name()), filepath.Join(target, entry.Name())
		if renameErr := os.Rename(from, to); renameErr == nil {
			continue
		}
		if copyErr := copyFile(from, to); copyErr != nil {
			return copyErr
		}
	}
	return nil
}

func copyFile(from, to string) error {
	input, err := os.Open(from)
	if err != nil {
		return err
	}
	defer input.Close()
	info, err := input.Stat()
	if err != nil {
		return err
	}
	output, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, info.Mode().Perm()|0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(output, input); err != nil {
		output.Close()
		return err
	}
	return output.Close()
}
