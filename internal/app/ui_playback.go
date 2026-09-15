package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const playbackIdleTimeout = 2 * time.Minute
const playbackSessionLimit = 4
// avc1.4D401F = H.264 main profile level 3.1，与 playbackFFmpegArgs 的
// -profile:v main -level:v 3.1 对应（实测 avcC 为 01 4D 40 1F）。
// 改动转码 profile 时必须同步此常量和 player.js 的 isTypeSupported 探测。
const playbackMIME = `video/mp4; codecs="avc1.4D401F, mp4a.40.2"`

type playbackSession struct {
	id              string
	tasks           []Task
	downloadIDs     []string
	prepared        map[int]bool
	expires         time.Time
	timer           *time.Timer
	cancel          context.CancelFunc
	run             uint64
	state           string
	error           string
	duration        float64
	currentIndex    int
	prefetchVersion uint64
	prefetch        *playbackPrefetch
	// quality 是当前选定的画质（短边像素）。存在会话上，保证预缓存
	// 与主播放流用同一档位，否则切集时画质会跳变。
	quality int
	// meters 统计当前取流的上游与转码输出速率，供界面判断卡顿来源。
	// 每次新取流重建，不跨分集、跳转和画质切换累计。
	meters *playbackMeters
}

type playbackEpisode struct {
	Index   int    `json:"index"`
	Episode string `json:"episode"`
	Title   string `json:"title"`
	TaskID  string `json:"taskId,omitempty"`
	Danmaku bool   `json:"danmaku,omitempty"`
}

type playbackView struct {
	State    string                `json:"state"`
	Error    string                `json:"error,omitempty"`
	Run      uint64                `json:"run"`
	Duration float64               `json:"duration"`
	Prefetch *playbackPrefetchView `json:"prefetch,omitempty"`
	Meters   *playbackMetersView   `json:"meters,omitempty"`
}

func (app *UIApp) registerPlaybackRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/ui/playback/open", app.handlePlaybackOpen)
	mux.HandleFunc("/api/ui/playback/prepare", app.handlePlaybackPrepare)
	mux.HandleFunc("/api/ui/playback/stream", app.handlePlaybackStream)
	mux.HandleFunc("/api/ui/playback/control", app.handlePlaybackControl)
	mux.HandleFunc("/api/ui/playback/status", app.handlePlaybackStatus)
	mux.HandleFunc("/api/ui/playback/prefetch", app.handlePlaybackPrefetch)
	mux.HandleFunc("/api/ui/playback/danmaku", app.handlePlaybackDanmaku)
	mux.Handle("/assets/", playbackAssets())
}

func playbackRequestAllowed(writer http.ResponseWriter, request *http.Request, method string) bool {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	if request.Method != method {
		writer.Header().Set("Allow", method)
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]string{"error": "请求方法不支持"})
		return false
	}
	if site := request.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
		writeJSON(writer, http.StatusForbidden, map[string]string{"error": "请从剧库页面发起播放"})
		return false
	}
	if origin := request.Header.Get("Origin"); origin != "" {
		parsed, err := url.Parse(origin)
		if err != nil || parsed.User != nil || parsed.Scheme != "http" && parsed.Scheme != "https" || !strings.EqualFold(parsed.Host, request.Host) {
			writeJSON(writer, http.StatusForbidden, map[string]string{"error": "不允许跨站播放请求"})
			return false
		}
	}
	return true
}

func readPlaybackRequest(writer http.ResponseWriter, request *http.Request, destination any) bool {
	if !playbackRequestAllowed(writer, request, http.MethodPost) {
		return false
	}
	contentType, _, _ := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if contentType != "application/json" {
		writeJSON(writer, http.StatusUnsupportedMediaType, map[string]string{"error": "请求必须使用 JSON"})
		return false
	}
	decoder := json.NewDecoder(http.MaxBytesReader(writer, request.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "播放请求无效"})
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "播放请求包含多余数据"})
		return false
	}
	return true
}

func (app *UIApp) handlePlaybackOpen(writer http.ResponseWriter, request *http.Request) {
	var input struct {
		DramaID string `json:"dramaId"`
		TaskID  string `json:"taskId"`
	}
	if !readPlaybackRequest(writer, request, &input) {
		return
	}
	if input.TaskID != "" && input.DramaID != "" {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "请选择剧库播放或合集播放"})
		return
	}
	var drama Drama
	var title string
	var tasks []Task
	var downloadIDs []string
	initialIndex := 1
	var collectionErr error
	app.mu.Lock()
	if input.TaskID != "" {
		title, tasks, downloadIDs, initialIndex, collectionErr = app.collectionPlaybackTasksLocked(input.TaskID)
	} else {
		for _, candidate := range app.dramas {
			if candidate.ID == input.DramaID && input.DramaID != "" {
				drama = candidate
				break
			}
		}
	}
	app.mu.Unlock()
	if collectionErr != nil {
		writeJSON(writer, http.StatusNotFound, map[string]string{"error": app.redactError(collectionErr)})
		return
	}
	if input.TaskID == "" && drama.ID == "" {
		writeJSON(writer, http.StatusNotFound, map[string]string{"error": "此短剧不在当前剧库中，请刷新剧库后重试"})
		return
	}
	if _, err := app.downloader.ensureFFmpeg(request.Context()); err != nil {
		writeJSON(writer, http.StatusServiceUnavailable, map[string]string{"error": app.redactError(err)})
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 90*time.Second)
	defer cancel()
	id := randomHex(24)
	if id == "" {
		writeJSON(writer, http.StatusInternalServerError, map[string]string{"error": "无法创建播放会话"})
		return
	}
	app.playbackMu.Lock()
	if len(app.playbacks) >= playbackSessionLimit {
		app.playbackMu.Unlock()
		writeJSON(writer, http.StatusTooManyRequests, map[string]string{"error": "播放窗口过多，请先关闭其他播放窗口"})
		return
	}
	if app.playbacks == nil {
		app.playbacks = make(map[string]*playbackSession)
	}
	// quality 初始化为默认档：零值会让首次取流误判「画质已变更」而丢弃预缓存
	session := &playbackSession{id: id, expires: time.Now().Add(playbackIdleTimeout), state: "opening", cancel: cancel, quality: playbackMaxHeight}
	app.playbacks[id] = session
	session.timer = time.AfterFunc(playbackIdleTimeout, func() { app.expirePlayback(id) })
	app.playbackMu.Unlock()
	ready := false
	defer func() {
		if !ready {
			app.closePlayback(id)
		}
	}()
	if input.TaskID == "" {
		fetchedTitle, chapters, err := app.downloader.GetDramaChapters(ctx, drama.ID)
		if err == nil && len(chapters) == 0 {
			err = errors.New("站点未返回可播放的分集")
		}
		if err != nil {
			writeJSON(writer, http.StatusBadGateway, map[string]string{"error": "获取选集失败：" + app.redactError(err)})
			return
		}
		title = firstNonEmpty(fetchedTitle, drama.DisplayTitle())
		for index, chapter := range chapters {
			tasks = append(tasks, Task{DramaID: drama.ID, DramaTitle: title, Chapter: chapter, Index: index + 1, Total: len(chapters)})
		}
	}
	episodes := make([]playbackEpisode, 0, len(tasks))
	for index, task := range tasks {
		episode := playbackEpisode{Index: index + 1, Episode: task.Chapter.EpisodeString(task.Index), Title: task.Chapter.Title}
		_, _, episode.Danmaku = hongguoPlaybackIDs(task)
		if len(downloadIDs) > 0 {
			episode.TaskID = downloadIDs[index]
		}
		episodes = append(episodes, episode)
	}
	app.playbackMu.Lock()
	if app.playbacks[id] == session && ctx.Err() == nil {
		session.tasks = tasks
		session.downloadIDs = downloadIDs
		session.prepared = make(map[int]bool)
		session.cancel = nil
		session.state = "ready"
		app.touchPlaybackLocked(session)
		ready = true
	}
	app.playbackMu.Unlock()
	if !ready {
		writeJSON(writer, http.StatusRequestTimeout, map[string]string{"error": "播放准备超时，请重新打开本剧"})
		return
	}
	mode := "online"
	if len(downloadIDs) > 0 {
		mode = "collection"
	}
	writeJSON(writer, http.StatusOK, map[string]any{"session": id, "title": title, "episodes": episodes, "mimeType": playbackMIME, "mode": mode, "initialIndex": initialIndex, "qualityOptions": playbackQualityOptions, "defaultQuality": playbackMaxHeight})
}

func (app *UIApp) touchPlaybackLocked(session *playbackSession) {
	session.expires = time.Now().Add(playbackIdleTimeout)
	session.timer.Reset(playbackIdleTimeout)
}

func (app *UIApp) expirePlayback(id string) {
	app.playbackMu.Lock()
	session := app.playbacks[id]
	if session != nil && time.Now().Before(session.expires) {
		session.timer.Reset(time.Until(session.expires))
		app.playbackMu.Unlock()
		return
	}
	if session != nil {
		delete(app.playbacks, id)
	}
	app.playbackMu.Unlock()
	if session != nil && session.cancel != nil {
		session.cancel()
	}
	if session != nil && session.prefetch != nil {
		session.prefetch.cancel()
	}
}

func (app *UIApp) closePlayback(id string) {
	app.playbackMu.Lock()
	session := app.playbacks[id]
	if session != nil {
		delete(app.playbacks, id)
		session.timer.Stop()
	}
	app.playbackMu.Unlock()
	if session != nil && session.cancel != nil {
		session.cancel()
	}
	if session != nil && session.prefetch != nil {
		session.prefetch.cancel()
	}
}

func (app *UIApp) closePlaybacks() {
	app.playbackMu.Lock()
	sessions := app.playbacks
	app.playbacks = nil
	for _, session := range sessions {
		session.timer.Stop()
	}
	app.playbackMu.Unlock()
	for _, session := range sessions {
		if session.cancel != nil {
			session.cancel()
		}
		if session.prefetch != nil {
			session.prefetch.cancel()
		}
	}
}

func (app *UIApp) playbackStatus(id string, touch bool) (playbackView, bool) {
	app.playbackMu.Lock()
	defer app.playbackMu.Unlock()
	session := app.playbacks[id]
	if session == nil {
		return playbackView{}, false
	}
	if touch {
		app.touchPlaybackLocked(session)
	}
	view := playbackView{State: session.state, Error: session.error, Run: session.run, Duration: session.duration}
	if session.prefetch != nil {
		view.Prefetch = session.prefetch.view()
	}
	view.Meters = session.meters.view()
	return view, true
}

func (app *UIApp) handlePlaybackControl(writer http.ResponseWriter, request *http.Request) {
	var input struct {
		Session string `json:"session"`
		Action  string `json:"action"`
	}
	if !readPlaybackRequest(writer, request, &input) {
		return
	}
	if input.Action == "close" {
		app.closePlayback(input.Session)
		writeJSON(writer, http.StatusOK, map[string]bool{"ok": true})
		return
	}
	if input.Action != "heartbeat" {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "不支持此播放操作"})
		return
	}
	if state, ok := app.playbackStatus(input.Session, true); ok {
		writeJSON(writer, http.StatusOK, state)
	} else {
		writeJSON(writer, http.StatusGone, map[string]string{"error": "播放会话已过期，请重新打开本剧"})
	}
}

func (app *UIApp) handlePlaybackStatus(writer http.ResponseWriter, request *http.Request) {
	if !playbackRequestAllowed(writer, request, http.MethodGet) {
		return
	}
	if state, ok := app.playbackStatus(request.URL.Query().Get("session"), false); ok {
		writeJSON(writer, http.StatusOK, state)
	} else {
		writeJSON(writer, http.StatusGone, map[string]string{"error": "播放会话已过期，请重新打开本剧"})
	}
}

func (app *UIApp) handlePlaybackStream(writer http.ResponseWriter, request *http.Request) {
	if !playbackRequestAllowed(writer, request, http.MethodGet) {
		return
	}
	query := request.URL.Query()
	index, indexErr := strconv.Atoi(query.Get("episode"))
	offset, offsetErr := strconv.ParseFloat(firstNonEmpty(query.Get("start"), "0"), 64)
	if indexErr != nil || index < 1 || offsetErr != nil || math.IsNaN(offset) || math.IsInf(offset, 0) || offset < 0 || offset > 24*60*60 {
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "集数或播放位置无效"})
		return
	}
	// 画质为可选参数，非法值由 normalizePlaybackQuality 回落到默认档
	quality := normalizePlaybackQuality(func() int {
		value, err := strconv.Atoi(query.Get("quality"))
		if err != nil {
			return 0
		}
		return value
	}())
	id := query.Get("session")
	app.playbackMu.Lock()
	session := app.playbacks[id]
	if session == nil {
		app.playbackMu.Unlock()
		writeJSON(writer, http.StatusGone, map[string]string{"error": "播放会话已过期，请重新打开本剧"})
		return
	}
	if index > len(session.tasks) {
		app.playbackMu.Unlock()
		writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "分集不存在"})
		return
	}
	downloadID := ""
	if len(session.downloadIDs) > 0 {
		if !session.prepared[index] {
			app.playbackMu.Unlock()
			writeJSON(writer, http.StatusConflict, map[string]string{"error": "请先选择要播放的分集"})
			return
		}
		downloadID = session.downloadIDs[index-1]
	}
	previousCancel := session.cancel
	cache := session.prefetch
	session.prefetch = nil
	// 画质变了要丢掉预缓存：它是按旧档位转码的。
	// 两侧都归一化后再比，避免零值（新建或旧会话）被误判为「已变更」而白丢缓存。
	qualityChanged := normalizePlaybackQuality(session.quality) != quality
	session.quality = quality
	if cache != nil && (offset != 0 || cache.episode != index || cache.fromRun != session.run || qualityChanged) {
		cache.cancel()
		cache = nil
	}
	ctx, cancel := context.WithCancel(request.Context())
	stop := func() {
		cancel()
		if cache != nil {
			cache.cancel()
		}
	}
	session.cancel = stop
	session.run++
	session.currentIndex = index
	session.prefetchVersion = 0
	// 每次取流都换一组新计数器：换集、拖动、切画质都应从零开始，
	// 否则速率窗口会把上一路流的字节算进来。
	meters := &playbackMeters{}
	session.meters = meters
	run := session.run
	task := session.tasks[index-1]
	session.state, session.error, session.duration = "buffering", "", 0
	app.touchPlaybackLocked(session)
	app.playbackMu.Unlock()
	if previousCancel != nil {
		previousCancel()
	}
	defer stop()
	startupTimer := time.AfterFunc(90*time.Second, cancel)
	defer startupTimer.Stop()
	ready := func(duration float64) {
		startupTimer.Stop()
		app.playbackMu.Lock()
		if current := app.playbacks[id]; current == session && current.run == run {
			current.state, current.duration = "streaming", duration
		}
		app.playbackMu.Unlock()
	}
	used, err := app.servePrefetchedPlayback(ctx, writer, cache, run, ready)
	if !used {
		err = app.streamPlayback(ctx, cancel, writer, task, downloadID, offset, run, quality, meters, ready)
	}
	app.playbackMu.Lock()
	if current := app.playbacks[id]; current == session && current.run == run {
		current.cancel = nil
		current.state = "ended"
		if err != nil {
			current.state = "failed"
			current.error = app.redactError(err)
			if request.Context().Err() != nil {
				current.state = "stopped"
			}
		}
	}
	app.playbackMu.Unlock()
}
