package app

import (
	"context"
	"net/http"
	"strconv"
	"sync"
	"time"
)

const playbackPrefetchChunkSize = 64 * 1024
const playbackPrefetchChunks = 512

type playbackPrefetchKey struct{}

type playbackPrefetch struct {
	episode int
	fromRun uint64
	ctx     context.Context
	cancel  context.CancelFunc
	chunks  chan []byte
	ready   chan struct{}
	done    chan struct{}
	once    sync.Once
	headers http.Header
	status  int
	mu      sync.Mutex
	header  http.Header
	err     error
}

type playbackPrefetchView struct {
	Episode int    `json:"episode"`
	State   string `json:"state"`
}

func newPlaybackPrefetch(episode int, run uint64) *playbackPrefetch {
	ctx := context.WithValue(context.Background(), backgroundCatalogKey{}, true)
	ctx = context.WithValue(ctx, playbackPrefetchKey{}, true)
	ctx, cancel := context.WithCancel(ctx)
	return &playbackPrefetch{episode: episode, fromRun: run, ctx: ctx, cancel: cancel,
		chunks: make(chan []byte, playbackPrefetchChunks), ready: make(chan struct{}), done: make(chan struct{}), headers: make(http.Header)}
}

func (cache *playbackPrefetch) Header() http.Header              { return cache.headers }
func (cache *playbackPrefetch) WriteHeader(status int)           { cache.status = status }
func (cache *playbackPrefetch) Flush()                           {}
func (cache *playbackPrefetch) SetWriteDeadline(time.Time) error { return nil }

func (cache *playbackPrefetch) Write(data []byte) (int, error) {
	if cache.status == 0 {
		cache.status = http.StatusOK
	}
	if cache.status != http.StatusOK {
		return len(data), nil
	}
	cache.once.Do(func() {
		cache.mu.Lock()
		cache.header = cache.headers.Clone()
		cache.mu.Unlock()
		close(cache.ready)
	})
	written := 0
	for len(data) > 0 {
		size := len(data)
		if size > playbackPrefetchChunkSize {
			size = playbackPrefetchChunkSize
		}
		chunk := append([]byte(nil), data[:size]...)
		select {
		case cache.chunks <- chunk:
			data = data[size:]
			written += size
		case <-cache.ctx.Done():
			return written, cache.ctx.Err()
		}
	}
	return written, nil
}

func (cache *playbackPrefetch) finish(err error) {
	cache.mu.Lock()
	cache.err = err
	cache.mu.Unlock()
	close(cache.chunks)
	close(cache.done)
	cache.once.Do(func() { close(cache.ready) })
}

func (cache *playbackPrefetch) view() *playbackPrefetchView {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	state := "preparing"
	if cache.err != nil {
		state = "failed"
	} else if cache.header != nil {
		state = "buffering"
		select {
		case <-cache.done:
			state = "ready"
		default:
		}
	}
	return &playbackPrefetchView{Episode: cache.episode, State: state}
}

func (cache *playbackPrefetch) serve(ctx context.Context, writer http.ResponseWriter, run uint64, ready func(float64)) (bool, error) {
	select {
	case <-cache.ready:
	case <-ctx.Done():
		return true, ctx.Err()
	}
	cache.mu.Lock()
	header, failed := cache.header, cache.err
	cache.mu.Unlock()
	if failed != nil || header == nil {
		return false, nil
	}
	var first []byte
	select {
	case chunk, ok := <-cache.chunks:
		if !ok {
			return false, nil
		}
		first = chunk
	case <-ctx.Done():
		return true, ctx.Err()
	}
	for _, name := range []string{"Content-Type", "Content-Disposition", "X-Playback-Duration", "X-Playback-Source"} {
		if value := header.Get(name); value != "" {
			writer.Header().Set(name, value)
		}
	}
	writer.Header().Set("X-Playback-Run", strconv.FormatUint(run, 10))
	writer.Header().Set("X-Playback-Prefetched", "1")
	duration, _ := strconv.ParseFloat(header.Get("X-Playback-Duration"), 64)
	ready(duration)
	controller := http.NewResponseController(writer)
	interrupted := make(chan struct{})
	stopInterrupt := context.AfterFunc(ctx, func() { _ = controller.SetWriteDeadline(time.Now()); close(interrupted) })
	defer func() {
		if !stopInterrupt() {
			<-interrupted
		}
		_ = controller.SetWriteDeadline(time.Time{})
	}()
	for {
		if _, err := writer.Write(first); err != nil {
			return true, err
		}
		if err := controller.Flush(); err != nil {
			return true, err
		}
		select {
		case chunk, ok := <-cache.chunks:
			if !ok {
				<-cache.done
				cache.mu.Lock()
				err := cache.err
				cache.mu.Unlock()
				return true, err
			}
			first = chunk
		case <-ctx.Done():
			return true, ctx.Err()
		}
	}
}

func (app *UIApp) handlePlaybackPrefetch(writer http.ResponseWriter, request *http.Request) {
	var input struct {
		Session string `json:"session"`
		Episode int    `json:"episode"`
		Run     uint64 `json:"run"`
		Version uint64 `json:"version"`
		Cancel  bool   `json:"cancel"`
	}
	if !readPlaybackRequest(writer, request, &input) {
		return
	}
	app.playbackMu.Lock()
	session := app.playbacks[input.Session]
	if session == nil {
		app.playbackMu.Unlock()
		writeJSON(writer, http.StatusGone, map[string]string{"error": "播放会话已过期"})
		return
	}
	if input.Run != session.run || input.Version == 0 || input.Version < session.prefetchVersion {
		app.playbackMu.Unlock()
		writeJSON(writer, http.StatusConflict, map[string]string{"error": "播放分集已变化"})
		return
	}
	if !input.Cancel && (input.Episode < 1 || input.Episode != session.currentIndex+1 || input.Episode > len(session.tasks)) {
		app.playbackMu.Unlock()
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "只能预缓存当前集的下一集"})
		return
	}
	if !input.Cancel && session.state != "ended" {
		app.playbackMu.Unlock()
		writeJSON(writer, http.StatusConflict, map[string]string{"error": "当前集尚未缓冲完成"})
		return
	}
	session.prefetchVersion = input.Version
	app.touchPlaybackLocked(session)
	previous := session.prefetch
	if input.Cancel {
		session.prefetch = nil
		app.playbackMu.Unlock()
		if previous != nil {
			previous.cancel()
		}
		writeJSON(writer, http.StatusOK, map[string]bool{"ok": true})
		return
	}
	if previous != nil && previous.episode == input.Episode && previous.fromRun == input.Run {
		view := previous.view()
		app.playbackMu.Unlock()
		writeJSON(writer, http.StatusOK, view)
		return
	}
	cache := newPlaybackPrefetch(input.Episode, input.Run)
	session.prefetch = cache
	task := session.tasks[input.Episode-1]
	downloadID := ""
	if len(session.downloadIDs) > 0 {
		downloadID = session.downloadIDs[input.Episode-1]
	}
	if app.playbackPrefetchSlots == nil {
		app.playbackPrefetchSlots = make(chan struct{}, 1)
	}
	slots := app.playbackPrefetchSlots
	// 预缓存必须沿用会话当前画质，否则切集时画质会跳变
	quality := normalizePlaybackQuality(session.quality)
	app.playbackMu.Unlock()
	if previous != nil {
		previous.cancel()
	}
	go func() {
		select {
		case slots <- struct{}{}:
			defer func() { <-slots }()
		case <-cache.ctx.Done():
			cache.finish(cache.ctx.Err())
			return
		}
		defer cache.cancel()
		startup := time.AfterFunc(60*time.Second, cache.cancel)
		defer startup.Stop()
		err := app.streamPlayback(cache.ctx, cache.cancel, cache, task, downloadID, 0, 0, quality, func(float64) { startup.Stop() })
		cache.finish(err)
	}()
	writeJSON(writer, http.StatusAccepted, &playbackPrefetchView{Episode: input.Episode, State: "preparing"})
}

func (app *UIApp) servePrefetchedPlayback(ctx context.Context, writer http.ResponseWriter, cache *playbackPrefetch, run uint64, ready func(float64)) (bool, error) {
	if cache == nil {
		return false, nil
	}
	used, err := cache.serve(ctx, writer, run, ready)
	if !used {
		cache.cancel()
	}
	return used, err
}

var _ http.ResponseWriter = (*playbackPrefetch)(nil)
