package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// playbackQualityKey 传递在线点播的清晰度高度上限（像素）。
// 下载不设置此值，保持原有「选最高画质」行为。
type playbackQualityKey struct{}

func (downloader *Downloader) resolveHongguoAppMedia(ctx context.Context, videoID string) (providerMedia, error) {
	if !hongguoNumericID.MatchString(videoID) {
		return providerMedia{}, errors.New("红果视频 ID 无效")
	}
	payload := map[string]any{
		"video_id": videoID, "content_type": 1,
		"biz_param": map[string]any{"need_all_video_definition": true, "video_platform": 3},
	}
	result, err := downloader.hongguoAppRequest(ctx, http.MethodPost, "/novel/player/video_model/v1/", nil, payload)
	if err != nil {
		return providerMedia{}, err
	}
	data := nestedMap(result, "data")
	model, _ := data["video_model"].(map[string]any)
	if encoded, ok := data["video_model"].(string); ok {
		decoder := json.NewDecoder(strings.NewReader(encoded))
		decoder.UseNumber()
		if err := decoder.Decode(&model); err != nil {
			return providerMedia{}, errors.New("红果 App 播放信息格式异常")
		}
	}
	maxHeight, _ := ctx.Value(playbackQualityKey{}).(int)
	return selectHongguoAppMediaCapped(model, maxHeight)
}

func selectHongguoAppMedia(model map[string]any) (providerMedia, error) {
	return selectHongguoAppMediaCapped(model, 0)
}

// selectHongguoAppMediaCapped 从候选清晰度中挑选媒体。
// maxHeight > 0 时（在线点播）优先选不超过该高度的最高档，避免为超出播放
// 窗口的分辨率白烧转码算力；全部档位都超限时退回其中最小的一档，保证有画面。
// maxHeight <= 0 时（下载）保持原有「选最高画质」行为。
func selectHongguoAppMediaCapped(model map[string]any, maxHeight int) (providerMedia, error) {
	variants := anyList(model["video_list"])
	if rows, ok := model["video_list"].(map[string]any); ok && len(variants) == 0 {
		keys := make([]string, 0, len(rows))
		for key := range rows {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			variants = append(variants, rows[key])
		}
	}
	duration, _ := strconv.ParseFloat(mapString(model, "video_duration", "duration"), 64)
	var selected providerMedia
	bestRank := -1
	bestNominal := 0
	// 全部档位都超出 maxHeight 时的兜底，保留其中最小的一档
	var fallback providerMedia
	fallbackRank := 0
	var keyErr error
	for _, row := range variants {
		variant, _ := row.(map[string]any)
		meta := nestedMap(variant, "video_meta")
		codec := strings.ToLower(mapString(meta, "codec_type"))
		if codec == "bytevc2" || strings.Contains(strings.ToLower(mapString(variant, "gear_des_key")), "bytevc2") {
			continue
		}
		address := mapString(variant, "main_url")
		if len(address) > 8192 || !isProviderHTTPMediaURL(address) {
			continue
		}
		media := providerMedia{URL: address, Referer: "https://novel.snssdk.com/", Duration: time.Duration(duration * float64(time.Second))}
		encryption := nestedMap(variant, "encrypt_info")
		spade := mapString(encryption, "spade_a")
		if spade != "" || encryption["encrypt"] == true || mapString(encryption, "encryption_method") == "cenc-aes-ctr" {
			var err error
			media.CENCKey, err = hongguoContentKey(spade)
			if err != nil {
				keyErr = err
				continue
			}
		}
		// 标称档位（definition，如 "1080p"）与真实像素可能不一致：源站存在标称
		// 1080p 实际只有 720x1280 的档位，码率更高但画面并不更清晰。
		nominal, _ := strconv.Atoi(mapString(meta, "vheight"))
		if definition, err := strconv.Atoi(hongguoQualityNumber.FindString(mapString(meta, "definition"))); err == nil && definition > 0 {
			nominal = definition
		}
		// 竖屏短剧的「720p」指短边，所以按宽高中的较小值衡量真实清晰度。
		pixelShortSide := nominal
		if width, err := strconv.Atoi(mapString(meta, "vwidth")); err == nil && width > 0 {
			if realHeight, err := strconv.Atoi(mapString(meta, "vheight")); err == nil && realHeight > 0 {
				pixelShortSide = min(width, realHeight)
			}
		}
		// 下载按标称档位选最高，保持原有行为；在线点播改按真实像素排序，
		// 避免为「标称更高但像素相同」的档位白烧码率和转码算力。
		rank := nominal * 10
		if maxHeight > 0 {
			rank = pixelShortSide * 10
		}
		if codec == "h264" || codec == "avc1" {
			rank++
		}
		if maxHeight > 0 && pixelShortSide > maxHeight {
			// 超出上限：只留作兜底，取其中最小的一档，保证仍有画面
			if fallback.URL == "" || rank < fallbackRank {
				fallback, fallbackRank = media, rank
			}
			continue
		}
		// 真实像素相同时优先标称更低的一档：同样画质但码率更省
		if selected.URL == "" || rank > bestRank || rank == bestRank && nominal < bestNominal {
			selected, bestRank, bestNominal = media, rank, nominal
		}
	}
	if selected.URL != "" {
		return selected, nil
	}
	if fallback.URL != "" {
		return fallback, nil
	}
	if keyErr != nil {
		return providerMedia{}, fmt.Errorf("红果 App 媒体密钥不可用: %w", keyErr)
	}
	return providerMedia{}, errors.New("红果 App 未返回兼容的媒体，已跳过不支持的编码")
}
