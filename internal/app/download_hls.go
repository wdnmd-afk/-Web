package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type hlsAsset struct {
	remote   string
	body     []byte
	playlist bool
}

type hlsProxy struct {
	client   *http.Client
	server   *http.Server
	base     string
	referer  string
	key      []byte
	mediaKey []byte
	mu       sync.Mutex
	assets   map[string]hlsAsset
	assetIDs map[string]string
	failure  error
	root     string
	retries  int
	// meter 可选，仅点播链路设置：统计从站源实际拉取的媒体字节，用于界面显示上游网速。
	// 下载链路不设置，保持原有行为不变。
	meter *playbackRateMeter
}

var hlsURIAttribute = regexp.MustCompile(`URI="([^"]+)"`)

func (d *Downloader) newHLSProxy(ctx context.Context, media providerMedia, key []byte) (*hlsProxy, error) {
	nonce := randomHex(16)
	if nonce == "" {
		return nil, errors.New("无法创建本地下载会话")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("创建本地 HLS 转发失败: %w", err)
	}
	proxy := &hlsProxy{
		client:   &http.Client{Transport: d.client.Transport},
		base:     "http://" + listener.Addr().String() + "/" + nonce + "/",
		referer:  media.Referer,
		key:      key,
		mediaKey: media.HLSKey,
		assets:   map[string]hlsAsset{},
		assetIDs: map[string]string{},
		retries:  d.cfg.Retries,
	}
	proxy.root = proxy.addAsset(hlsAsset{remote: media.URL, body: []byte(media.Playlist), playlist: media.Playlist != ""})
	proxy.server = &http.Server{
		Handler:           proxy,
		ReadHeaderTimeout: 5 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}
	go func() {
		if err := proxy.server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			proxy.recordError(err)
		}
	}()
	return proxy, nil
}

func (proxy *hlsProxy) Close() { _ = proxy.server.Close() }

func (proxy *hlsProxy) Err() error {
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	return proxy.failure
}

func (proxy *hlsProxy) recordError(err error) {
	proxy.mu.Lock()
	if proxy.failure == nil {
		proxy.failure = publicError(err)
	}
	proxy.mu.Unlock()
}

func (proxy *hlsProxy) addAsset(asset hlsAsset) string {
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	if existing := proxy.assetIDs[asset.remote]; existing != "" {
		return existing
	}
	extension := ".ts"
	if asset.playlist {
		extension = ".m3u8"
	} else if len(asset.body) > 0 {
		extension = ".key"
	}
	local := proxy.base + strconv.Itoa(len(proxy.assets)+1) + extension
	parsed, _ := url.Parse(local)
	proxy.assets[parsed.Path] = asset
	proxy.assetIDs[asset.remote] = local
	return local
}

func (proxy *hlsProxy) rewritePlaylist(raw, baseURL string) (string, error) {
	base, err := url.Parse(baseURL)
	if err != nil {
		return "", err
	}
	rewrite := func(reference string, playlist, key bool) (string, error) {
		parsed, err := url.Parse(reference)
		if err != nil {
			return "", err
		}
		remote := base.ResolveReference(parsed).String()
		if !isProviderHTTPMediaURL(remote) {
			return "", errors.New("HLS 包含非 HTTP/HTTPS 资源地址")
		}
		asset := hlsAsset{remote: remote, playlist: playlist || strings.HasSuffix(strings.ToLower(parsed.Path), ".m3u8")}
		resolved, _ := url.Parse(remote)
		if key && len(proxy.key) > 0 && strings.Contains(parsed.Path, "/api/app/vid/sec") {
			asset.body = proxy.key
		}
		if key && len(proxy.mediaKey) == 16 && strings.HasSuffix(resolved.Path, "/enc.key") {
			asset.body = proxy.mediaKey
		}
		return proxy.addAsset(asset), nil
	}
	lines := strings.Split(strings.TrimPrefix(raw, "\ufeff"), "\n")
	nextPlaylist := false
	for index, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "#EXT-X-STREAM-INF:") {
			nextPlaylist = true
		}
		if strings.HasPrefix(trimmed, "#") {
			var rewriteErr error
			lines[index] = hlsURIAttribute.ReplaceAllStringFunc(line, func(attribute string) string {
				reference := hlsURIAttribute.FindStringSubmatch(attribute)[1]
				local, err := rewrite(reference, strings.HasPrefix(trimmed, "#EXT-X-MEDIA:") || strings.HasPrefix(trimmed, "#EXT-X-I-FRAME-STREAM-INF:"), strings.HasPrefix(trimmed, "#EXT-X-KEY:"))
				if err != nil {
					rewriteErr = err
					return attribute
				}
				return `URI="` + local + `"`
			})
			if rewriteErr != nil {
				return "", rewriteErr
			}
		} else if trimmed != "" {
			lines[index], err = rewrite(trimmed, nextPlaylist, false)
			if err != nil {
				return "", err
			}
			nextPlaylist = false
		}
	}
	return strings.Join(lines, "\n"), nil
}

func (proxy *hlsProxy) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		writer.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	proxy.mu.Lock()
	asset, found := proxy.assets[request.URL.Path]
	proxy.mu.Unlock()
	if !found {
		http.NotFound(writer, request)
		return
	}
	body := asset.body
	if len(body) == 0 {
		method := request.Method
		if asset.playlist {
			method = http.MethodGet
		}
		upstream, err := http.NewRequestWithContext(request.Context(), method, asset.remote, nil)
		if err != nil {
			proxy.fail(writer, err)
			return
		}
		upstream.Header.Set("User-Agent", userAgent)
		upstream.Header.Set("Referer", proxy.referer)
		upstream.Header.Set("Accept-Encoding", "identity")
		if origin, err := url.Parse(proxy.referer); err == nil && origin.Host != "" {
			upstream.Header.Set("Origin", origin.Scheme+"://"+origin.Host)
		}
		for _, header := range []string{"Range", "If-Range"} {
			if value := request.Header.Get(header); value != "" {
				upstream.Header.Set(header, value)
			}
		}
		response, err := proxy.fetch(upstream)
		if err != nil {
			proxy.fail(writer, err)
			return
		}
		defer response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			proxy.fail(writer, fmt.Errorf("HLS 资源请求失败: %s HTTP %d", upstream.URL.Hostname(), response.StatusCode))
			return
		}
		if asset.playlist || strings.Contains(response.Header.Get("Content-Type"), "mpegurl") {
			body, err = io.ReadAll(io.LimitReader(response.Body, providerMaxBodyBytes+1))
			if err != nil || len(body) > providerMaxBodyBytes {
				proxy.fail(writer, errors.New("读取 HLS 播放列表失败或内容过大"))
				return
			}
			asset.playlist = true
			if response.Request != nil {
				asset.remote = response.Request.URL.String()
			}
		} else {
			for _, header := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"} {
				if value := response.Header.Get(header); value != "" {
					writer.Header().Set(header, value)
				}
			}
			writer.WriteHeader(response.StatusCode)
			var segment io.Reader = &checkedMediaReader{reader: response.Body, ctx: request.Context(), fail: proxy.recordError}
			// 点播会话会挂上计量器，用于统计真实的上游拉流速度；
			// 下载路径不设置 meter，行为与原先完全一致。
			if proxy.meter != nil {
				segment = &meteredReader{reader: segment, meter: proxy.meter}
			}
			_, _ = io.Copy(writer, segment)
			return
		}
	}
	if asset.playlist {
		if !bytes.HasPrefix(bytes.TrimSpace(bytes.TrimPrefix(body, []byte("\ufeff"))), []byte("#EXTM3U")) {
			proxy.fail(writer, errors.New("上游没有返回有效的 HLS 播放列表"))
			return
		}
		rewritten, err := proxy.rewritePlaylist(string(body), asset.remote)
		if err != nil {
			proxy.fail(writer, err)
			return
		}
		body = []byte(rewritten)
		writer.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	} else {
		writer.Header().Set("Content-Type", "application/octet-stream")
	}
	writer.Header().Set("Content-Length", strconv.Itoa(len(body)))
	if request.Method != http.MethodHead {
		_, _ = writer.Write(body)
	}
}

func (proxy *hlsProxy) fetch(request *http.Request) (*http.Response, error) {
	attempts := proxy.retries
	if attempts < 1 {
		attempts = 1
	}
	if attempts > 3 {
		attempts = 3
	}
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		if attempt > 0 {
			timer := time.NewTimer(time.Duration(attempt) * time.Second)
			select {
			case <-timer.C:
			case <-request.Context().Done():
				timer.Stop()
				return nil, request.Context().Err()
			}
		}
		response, err := proxy.client.Do(request.Clone(request.Context()))
		if err == nil {
			return response, nil
		}
		if request.Context().Err() != nil {
			return nil, request.Context().Err()
		}
		lastErr = err
	}
	return nil, fmt.Errorf("媒体资源连接失败（%s，已尝试 %d 次；可在代理设置中检测连接）: %w", request.URL.Hostname(), attempts, publicError(lastErr))
}

type checkedMediaReader struct {
	reader io.Reader
	ctx    context.Context
	fail   func(error)
}

func (reader *checkedMediaReader) Read(buffer []byte) (int, error) {
	count, err := reader.reader.Read(buffer)
	if err != nil && !errors.Is(err, io.EOF) && reader.ctx.Err() == nil {
		reader.fail(fmt.Errorf("媒体资源读取不完整: %w", err))
	}
	return count, err
}

func (proxy *hlsProxy) fail(writer http.ResponseWriter, err error) {
	proxy.recordError(err)
	http.Error(writer, "上游媒体请求失败", http.StatusBadGateway)
}
