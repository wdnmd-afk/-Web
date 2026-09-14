package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 观看历史：按剧记录最近观看的分集与进度，每集单独保存位置，
// 供“继续观看”和播放器选集标记使用。数据存放在 data/history.json，
// 与任务状态、剧库缓存分开，避免高频的进度上报反复重写大文件。
const (
	watchHistoryFile     = "history.json"
	watchHistoryLimit    = 300
	watchHistorySaveWait = 1500 * time.Millisecond
	// 播完 97% 以上视为看完；短剧片尾很短，太严格会永远标不上“已看”。
	watchFinishedRatio = 0.97
)

type watchEpisodeRecord struct {
	Index     int       `json:"index"`
	Episode   string    `json:"episode,omitempty"`
	Position  float64   `json:"position"`
	Duration  float64   `json:"duration"`
	Finished  bool      `json:"finished"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type watchHistoryEntry struct {
	DramaID      string                         `json:"dramaId"`
	Title        string                         `json:"title"`
	Cover        string                         `json:"cover,omitempty"`
	Channel      string                         `json:"channel,omitempty"`
	EpisodeCount int                            `json:"episodeCount,omitempty"`
	Mode         string                         `json:"mode,omitempty"`
	TaskID       string                         `json:"taskId,omitempty"`
	LastIndex    int                            `json:"lastIndex"`
	LastEpisode  string                         `json:"lastEpisode,omitempty"`
	Position     float64                        `json:"position"`
	Duration     float64                        `json:"duration"`
	Finished     bool                           `json:"finished"`
	UpdatedAt    time.Time                      `json:"updatedAt"`
	Episodes     map[string]*watchEpisodeRecord `json:"episodes,omitempty"`
}

type watchHistoryFileBody struct {
	Entries []*watchHistoryEntry `json:"entries"`
}

type watchHistoryReport struct {
	DramaID      string  `json:"dramaId"`
	Title        string  `json:"title"`
	Cover        string  `json:"cover"`
	Channel      string  `json:"channel"`
	EpisodeCount int     `json:"episodeCount"`
	Mode         string  `json:"mode"`
	TaskID       string  `json:"taskId"`
	Index        int     `json:"index"`
	Episode      string  `json:"episode"`
	Position     float64 `json:"position"`
	Duration     float64 `json:"duration"`
	Finished     bool    `json:"finished"`
}

type watchHistoryStore struct {
	path    string
	mu      sync.Mutex
	entries map[string]*watchHistoryEntry
	loaded  bool
	dirty   bool
	timer   *time.Timer
	now     func() time.Time
}

func newWatchHistoryStore(dataDirectory string) *watchHistoryStore {
	return &watchHistoryStore{path: filepath.Join(dataDirectory, watchHistoryFile), entries: map[string]*watchHistoryEntry{}, now: time.Now}
}

func (store *watchHistoryStore) loadLocked() {
	if store.loaded {
		return
	}
	store.loaded = true
	body, err := os.ReadFile(store.path)
	if err != nil {
		return
	}
	var file watchHistoryFileBody
	if err := json.Unmarshal(body, &file); err != nil {
		return
	}
	for _, entry := range file.Entries {
		if entry == nil || strings.TrimSpace(entry.DramaID) == "" {
			continue
		}
		if entry.Episodes == nil {
			entry.Episodes = map[string]*watchEpisodeRecord{}
		}
		store.entries[entry.DramaID] = entry
	}
}

func (store *watchHistoryStore) sortedLocked() []*watchHistoryEntry {
	list := make([]*watchHistoryEntry, 0, len(store.entries))
	for _, entry := range store.entries {
		list = append(list, entry)
	}
	sort.SliceStable(list, func(left, right int) bool {
		return list[left].UpdatedAt.After(list[right].UpdatedAt)
	})
	return list
}

// List 返回按最近观看排序的历史，返回值是副本，调用方可以自由修改。
func (store *watchHistoryStore) List() []watchHistoryEntry {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.loadLocked()
	sorted := store.sortedLocked()
	result := make([]watchHistoryEntry, 0, len(sorted))
	for _, entry := range sorted {
		copied := *entry
		copied.Episodes = make(map[string]*watchEpisodeRecord, len(entry.Episodes))
		for key, record := range entry.Episodes {
			duplicate := *record
			copied.Episodes[key] = &duplicate
		}
		result = append(result, copied)
	}
	return result
}

// Report 记录一次进度上报并返回更新后的条目。
func (store *watchHistoryStore) Report(report watchHistoryReport) (watchHistoryEntry, error) {
	dramaID := strings.TrimSpace(report.DramaID)
	if dramaID == "" {
		return watchHistoryEntry{}, errors.New("缺少剧集 ID")
	}
	if report.Index <= 0 {
		return watchHistoryEntry{}, errors.New("缺少分集序号")
	}
	if report.Position < 0 || report.Duration < 0 {
		return watchHistoryEntry{}, errors.New("进度无效")
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	store.loadLocked()
	now := store.now()
	entry := store.entries[dramaID]
	if entry == nil {
		entry = &watchHistoryEntry{DramaID: dramaID, Episodes: map[string]*watchEpisodeRecord{}}
		store.entries[dramaID] = entry
	}
	if title := strings.TrimSpace(report.Title); title != "" {
		entry.Title = title
	}
	if cover := strings.TrimSpace(report.Cover); cover != "" {
		entry.Cover = cover
	}
	if channel := strings.TrimSpace(report.Channel); channel != "" {
		entry.Channel = channel
	}
	if report.EpisodeCount > 0 {
		entry.EpisodeCount = report.EpisodeCount
	}
	if mode := strings.TrimSpace(report.Mode); mode != "" {
		entry.Mode = mode
	}
	if taskID := strings.TrimSpace(report.TaskID); taskID != "" {
		entry.TaskID = taskID
	}
	finished := report.Finished || report.Duration > 0 && report.Position >= report.Duration*watchFinishedRatio
	key := strconv.Itoa(report.Index)
	record := entry.Episodes[key]
	if record == nil {
		record = &watchEpisodeRecord{Index: report.Index}
		entry.Episodes[key] = record
	}
	record.Episode = firstNonEmpty(strings.TrimSpace(report.Episode), record.Episode)
	record.Position = report.Position
	if report.Duration > 0 {
		record.Duration = report.Duration
	}
	// 一旦看完就保持“已看”，之后回看开头不应把它变回未看。
	record.Finished = record.Finished || finished
	record.UpdatedAt = now
	entry.LastIndex = report.Index
	entry.LastEpisode = record.Episode
	entry.Position = report.Position
	entry.Duration = record.Duration
	entry.Finished = finished
	entry.UpdatedAt = now
	store.trimLocked()
	store.scheduleSaveLocked()
	result := *entry
	return result, nil
}

// Remove 删除指定剧集的历史；ids 为空且 all 为 true 时清空。
func (store *watchHistoryStore) Remove(ids []string, all bool) int {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.loadLocked()
	removed := 0
	if all {
		removed = len(store.entries)
		store.entries = map[string]*watchHistoryEntry{}
	} else {
		for _, id := range ids {
			if _, ok := store.entries[strings.TrimSpace(id)]; ok {
				delete(store.entries, strings.TrimSpace(id))
				removed++
			}
		}
	}
	if removed > 0 {
		store.scheduleSaveLocked()
	}
	return removed
}

func (store *watchHistoryStore) trimLocked() {
	if len(store.entries) <= watchHistoryLimit {
		return
	}
	sorted := store.sortedLocked()
	for _, entry := range sorted[watchHistoryLimit:] {
		delete(store.entries, entry.DramaID)
	}
}

// 进度上报每几秒一次，合并后延迟落盘，避免频繁写文件。
func (store *watchHistoryStore) scheduleSaveLocked() {
	store.dirty = true
	if store.timer != nil {
		return
	}
	store.timer = time.AfterFunc(watchHistorySaveWait, func() {
		store.mu.Lock()
		store.timer = nil
		store.mu.Unlock()
		_ = store.Flush()
	})
}

// Flush 立即把未保存的历史写入磁盘；退出前调用。
func (store *watchHistoryStore) Flush() error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if !store.dirty {
		return nil
	}
	if store.timer != nil {
		store.timer.Stop()
		store.timer = nil
	}
	body, err := json.MarshalIndent(watchHistoryFileBody{Entries: store.sortedLocked()}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(store.path), 0o755); err != nil {
		return err
	}
	tmp := store.path + ".tmp"
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, store.path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	store.dirty = false
	return nil
}

func (a *UIApp) watchHistory() *watchHistoryStore {
	a.historyOnce.Do(func() {
		a.history = newWatchHistoryStore(a.cfg.dataDirectory())
	})
	return a.history
}

func (a *UIApp) registerHistoryRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/ui/history", a.handleHistory)
	mux.HandleFunc("/api/ui/history/remove", a.handleHistoryRemove)
}

// handleHistory：GET 返回全部历史，POST 上报一次进度。
func (a *UIApp) handleHistory(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	switch r.Method {
	case http.MethodGet:
		entries := a.watchHistory().List()
		writeJSON(w, http.StatusOK, map[string]any{"data": entries, "total": len(entries)})
	case http.MethodPost:
		var report watchHistoryReport
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024))
		if err := dec.Decode(&report); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json: " + err.Error()})
			return
		}
		entry, err := a.watchHistory().Report(report)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"data": entry})
	default:
		w.Header().Set("Allow", "GET, POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "请求方法不支持"})
	}
}

func (a *UIApp) handleHistoryRemove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "请求方法不支持"})
		return
	}
	var req struct {
		IDs []string `json:"ids"`
		All bool     `json:"all"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256*1024))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json: " + err.Error()})
		return
	}
	if !req.All && len(req.IDs) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "请指定要删除的剧集"})
		return
	}
	removed := a.watchHistory().Remove(req.IDs, req.All)
	writeJSON(w, http.StatusOK, map[string]any{"removed": removed, "data": a.watchHistory().List()})
}
