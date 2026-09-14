package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"time"
)

var hongguoAppGenres = []struct {
	key   string
	scene string
	name  string
}{
	{key: "short_play", scene: "default", name: "真人剧"},
	{key: "comic_series", scene: "comic_series", name: "漫剧"},
	{key: "ai_series", scene: "ai_series", name: "AI剧"},
}

type libraryMoreKey struct{}
type libraryUpdateKey struct{}
type libraryKnownKey struct{}

func withKnownHongguoDramas(ctx context.Context, dramas []Drama) context.Context {
	known := make(map[string]bool, len(dramas))
	for _, drama := range dramas {
		known[drama.ID] = true
	}
	ctx = context.WithValue(ctx, libraryRowsKey{}, append([]Drama(nil), dramas...))
	return context.WithValue(ctx, libraryKnownKey{}, known)
}

func (downloader *Downloader) fetchHongguoAppCatalog(ctx context.Context) ([]Drama, error) {
	client := downloader.hongguoClient()
	client.catalogMu.Lock()
	defer client.catalogMu.Unlock()
	more, _ := ctx.Value(libraryMoreKey{}).(bool)
	update, _ := ctx.Value(libraryUpdateKey{}).(bool)
	known, _ := ctx.Value(libraryKnownKey{}).(map[string]bool)
	state := downloader.hongguoCatalogSnapshot()
	pageLimit := downloader.cfg.MaxPagesPerSort
	if pageLimit < 1 {
		pageLimit = defaultConfig().MaxPagesPerSort
	}
	if pageLimit > 200 {
		pageLimit = 200
	}
	headLimit := min(pageLimit, 3)
	roundLimit := pageLimit
	if update {
		roundLimit += headLimit
	}
	type feedScan struct {
		cursor hongguoCatalogCursor
		tail   hongguoCatalogCursor
		head   bool
		done   bool
		pages  int
	}
	scans := make([]feedScan, len(hongguoAppGenres))
	for index, genre := range hongguoAppGenres {
		cursor := state.Feeds[genre.key]
		if !more && cursor.Initialized {
			scans[index].head = true
			scans[index].tail = cursor
		} else {
			scans[index].cursor = cursor
			scans[index].done = cursor.Exhausted
		}
	}
	seen := map[string]int{}
	var dramas []Drama
	var failures []error
	for round := 0; round < roundLimit; round++ {
		active := false
		for index, genre := range hongguoAppGenres {
			scan := &scans[index]
			if scan.done || !scan.head && scan.pages >= pageLimit {
				continue
			}
			if err := ctx.Err(); err != nil {
				return dramas, err
			}
			active = true
			cursor := scan.cursor
			if time.Since(cursor.UpdatedAt) > 30*time.Minute {
				cursor.SessionID = ""
			}
			payload := map[string]any{
				"req_scene": genre.scene, "offset": cursor.Offset, "limit": 18,
				"req_type": "only_content", "need_selector_panel": false, "client_req_type": 3,
				"session_id": cursor.SessionID, "filter_ids": "",
				"select_items": map[string]any{
					"genre": []string{genre.key}, "sort": []string{"online_time"}, "gender": []string{},
					"category_dim_theme": []string{}, "category_dim_role": []string{}, "category_dim_epoch": []string{},
					"online_time": []string{}, "creation_status": []string{},
				},
			}
			if cursor.Offset > 0 {
				payload["client_req_type"] = 2
			}
			result, err := downloader.hongguoAppRequest(ctx, http.MethodPost, "/reading/distribution/category/landpage/v/", nil, payload)
			if err != nil && cursor.SessionID != "" && ctx.Err() == nil {
				payload["session_id"] = ""
				result, err = downloader.hongguoAppRequest(ctx, http.MethodPost, "/reading/distribution/category/landpage/v/", nil, payload)
			}
			data := nestedMap(result, "data")
			rows, valid := data["video_data"].([]any)
			if err == nil && !valid {
				err = errors.New("App 分类数据格式异常")
			}
			if err != nil {
				failures = append(failures, fmt.Errorf("%s: %w", genre.name, err))
				scan.done = true
				continue
			}
			items := make([]Drama, 0, len(rows))
			newItems := 0
			for _, row := range rows {
				drama := hongguoDramaFromAny(row, genre.name)
				if drama.ID != "" {
					items = append(items, drama)
					if !known[drama.ID] {
						newItems++
					}
					if position, exists := seen[drama.ID]; exists {
						dramas[position] = mergeDramaMetadata(drama, dramas[position])
					} else {
						seen[drama.ID] = len(dramas)
						dramas = append(dramas, drama)
					}
				}
			}
			if len(rows) > 0 && len(items) == 0 {
				failures = append(failures, fmt.Errorf("%s: App 分类未返回可识别的剧集", genre.name))
				scan.done = true
				continue
			}
			next, parseErr := strconv.Atoi(mapString(data, "next_offset"))
			hasMore, paginationOK := data["has_more"].(bool)
			if !paginationOK || hasMore && parseErr != nil {
				failures = append(failures, fmt.Errorf("%s: App 分页标记无效，已保留上次位置", genre.name))
				scan.done = true
				reportLibraryProgress(ctx, sourceHongguo, items, nil, false)
				continue
			}
			if parseErr != nil {
				next = cursor.Offset + len(rows)
			}
			lastID := ""
			if len(items) > 0 {
				lastID = items[len(items)-1].ID
			}
			if hasMore && (len(items) == 0 || next <= cursor.Offset || next > 1_000_000 || lastID == cursor.LastID) {
				failures = append(failures, fmt.Errorf("%s: App 分页未前进，已保留上次位置", genre.name))
				scan.done = true
				reportLibraryProgress(ctx, sourceHongguo, items, nil, false)
				continue
			}
			cursor.Exhausted = !hasMore
			cursor.Initialized = true
			cursor.Offset = next
			cursor.SessionID = mapString(data, "session_id")
			cursor.LastID = lastID
			cursor.UpdatedAt = time.Now()
			scan.pages++
			scan.cursor = cursor
			scan.done = cursor.Exhausted
			checkpoint := cursor
			if scan.head && newItems == 0 && !cursor.Exhausted {
				scan.done = true
				if scan.tail.Exhausted || scan.tail.Offset >= cursor.Offset {
					checkpoint = scan.tail
				}
			}
			if scan.head && (scan.done || scan.pages >= headLimit) {
				scan.done = true
				if update && !checkpoint.Exhausted {

					scan.cursor = checkpoint
					scan.head, scan.done, scan.pages = false, false, 0
				}
			}
			client.mu.Lock()
			client.state.Feeds[genre.key] = checkpoint
			client.mu.Unlock()
			reportLibraryProgress(ctx, sourceHongguo, items, nil, false)
		}
		if !active {
			break
		}
	}
	sort.SliceStable(dramas, func(left, right int) bool { return dramas[left].DisplayTitle() < dramas[right].DisplayTitle() })
	return dramas, errors.Join(failures...)
}
