package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestWatchHistoryReportAndResume(t *testing.T) {
	dir := t.TempDir()
	store := newWatchHistoryStore(dir)
	clock := time.Date(2026, 9, 14, 20, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return clock }

	if _, err := store.Report(watchHistoryReport{Title: "无 ID"}); err == nil {
		t.Fatal("缺少剧集 ID 应当报错")
	}
	entry, err := store.Report(watchHistoryReport{DramaID: "hongguo:1", Title: "测试剧", Cover: "c.jpg", EpisodeCount: 10, Index: 3, Episode: "3", Position: 30, Duration: 120})
	if err != nil {
		t.Fatalf("上报失败: %v", err)
	}
	if entry.LastIndex != 3 || entry.Position != 30 || entry.Finished || entry.Episodes["3"] == nil {
		t.Fatalf("条目不符合预期: %+v", entry)
	}

	clock = clock.Add(time.Minute)
	entry, _ = store.Report(watchHistoryReport{DramaID: "hongguo:1", Index: 3, Position: 118, Duration: 120})
	if !entry.Finished || !entry.Episodes["3"].Finished {
		t.Fatalf("播放到 97%% 以上应标记看完: %+v", entry)
	}
	// 回看开头不应撤销“已看”
	entry, _ = store.Report(watchHistoryReport{DramaID: "hongguo:1", Index: 3, Position: 2, Duration: 120})
	if entry.Finished || !entry.Episodes["3"].Finished {
		t.Fatalf("回看后集内已看标记应保留、当前进度应为未完成: %+v", entry)
	}
	if entry.Title != "测试剧" || entry.Cover != "c.jpg" || entry.EpisodeCount != 10 {
		t.Fatalf("省略的字段应保留旧值: %+v", entry)
	}

	clock = clock.Add(time.Minute)
	if _, err := store.Report(watchHistoryReport{DramaID: "hongguo:2", Title: "另一部", Index: 1, Position: 5, Duration: 60}); err != nil {
		t.Fatal(err)
	}
	list := store.List()
	if len(list) != 2 || list[0].DramaID != "hongguo:2" {
		t.Fatalf("应按最近观看排序: %+v", list)
	}

	if err := store.Flush(); err != nil {
		t.Fatalf("保存失败: %v", err)
	}
	body, err := os.ReadFile(filepath.Join(dir, watchHistoryFile))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "hongguo:1") {
		t.Fatalf("文件内容不含历史: %s", body)
	}
	reloaded := newWatchHistoryStore(dir)
	if got := reloaded.List(); len(got) != 2 || got[1].Episodes["3"] == nil || got[1].Episodes["3"].Position != 2 {
		t.Fatalf("重新读取后数据不一致: %+v", got)
	}
	if removed := reloaded.Remove([]string{"hongguo:1"}, false); removed != 1 || len(reloaded.List()) != 1 {
		t.Fatalf("删除失败: removed=%d", removed)
	}
	if removed := reloaded.Remove(nil, true); removed != 1 || len(reloaded.List()) != 0 {
		t.Fatalf("清空失败: removed=%d", removed)
	}
}

func TestWatchHistoryLimit(t *testing.T) {
	store := newWatchHistoryStore(t.TempDir())
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < watchHistoryLimit+5; i++ {
		clock := base.Add(time.Duration(i) * time.Second)
		store.now = func() time.Time { return clock }
		if _, err := store.Report(watchHistoryReport{DramaID: "d" + strings.Repeat("x", i%3) + string(rune('a'+i%26)) + strings.Repeat("y", i/26), Index: 1, Position: 1, Duration: 10}); err != nil {
			t.Fatal(err)
		}
	}
	if got := len(store.List()); got != watchHistoryLimit {
		t.Fatalf("应只保留 %d 条，实际 %d", watchHistoryLimit, got)
	}
}

func TestHistoryHandlers(t *testing.T) {
	app := &UIApp{cfg: Config{dataDir: t.TempDir()}}
	mux := http.NewServeMux()
	app.registerHistoryRoutes(mux)

	post := func(path, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, path, strings.NewReader(body)))
		return rec
	}
	if rec := post("/api/ui/history", `{"dramaId":"hongguo:9","title":"接口剧","index":2,"episode":"2","position":40,"duration":100}`); rec.Code != http.StatusOK {
		t.Fatalf("上报应成功: %d %s", rec.Code, rec.Body)
	}
	if rec := post("/api/ui/history", `{"index":2}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("缺少 ID 应 400: %d", rec.Code)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/ui/history", nil))
	var listed struct {
		Data  []watchHistoryEntry `json:"data"`
		Total int                 `json:"total"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil || listed.Total != 1 || listed.Data[0].LastIndex != 2 {
		t.Fatalf("列表不符合预期: %v %s", err, rec.Body)
	}
	if rec := post("/api/ui/history/remove", `{"ids":[]}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("空删除应 400: %d", rec.Code)
	}
	if rec := post("/api/ui/history/remove", `{"all":true}`); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"removed":1`) {
		t.Fatalf("清空失败: %d %s", rec.Code, rec.Body)
	}
}
