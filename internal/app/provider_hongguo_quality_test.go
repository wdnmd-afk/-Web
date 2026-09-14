package app

import "testing"

// 在线点播按短边像素封顶选流：不为超出播放窗口的分辨率白烧转码算力。
// 下载路径（maxHeight <= 0）必须保持原有「选最高画质」行为。
func TestSelectHongguoAppMediaCapsPlaybackQuality(t *testing.T) {
	// 还原实测数据的关键特征：标称 definition 不可信，
	// 实测存在 def=1080p 而真实像素只有 720x1280 的档位。
	model := map[string]any{
		"video_duration": "176.15",
		"video_list": []any{
			map[string]any{"main_url": "https://novel.snssdk.com/360.mp4",
				"video_meta": map[string]any{"codec_type": "bytevc1", "vwidth": "360", "vheight": "640", "definition": "360p"}},
			map[string]any{"main_url": "https://novel.snssdk.com/540.mp4",
				"video_meta": map[string]any{"codec_type": "bytevc1", "vwidth": "540", "vheight": "960", "definition": "540p"}},
			map[string]any{"main_url": "https://novel.snssdk.com/720.mp4",
				"video_meta": map[string]any{"codec_type": "bytevc1", "vwidth": "720", "vheight": "1280", "definition": "720p"}},
			// 标称 1080p 但真实像素与 720p 同为 720x1280：白烧码率的那一档
			map[string]any{"main_url": "https://novel.snssdk.com/fake1080.mp4",
				"video_meta": map[string]any{"codec_type": "bytevc1", "vwidth": "720", "vheight": "1280", "definition": "1080p"}},
		},
	}

	// 下载：保持选最高标称档
	download, err := selectHongguoAppMedia(model)
	if err != nil || download.URL != "https://novel.snssdk.com/fake1080.mp4" {
		t.Fatalf("下载路径应选最高档，实际 %q (%v)", download.URL, err)
	}

	// 播放封顶 720：短边 720 的档位可用，不应升到标称 1080p
	playback, err := selectHongguoAppMediaCapped(model, 720)
	if err != nil {
		t.Fatalf("封顶选流失败: %v", err)
	}
	if playback.URL == "https://novel.snssdk.com/fake1080.mp4" {
		t.Error("封顶后仍选中标称 1080p，白烧转码算力的问题没有解决")
	}
	if playback.URL != "https://novel.snssdk.com/720.mp4" {
		t.Errorf("封顶 720 应选真实 720 档，实际 %q", playback.URL)
	}

	// 封顶 540：应降到 540 档
	if media, err := selectHongguoAppMediaCapped(model, 540); err != nil || media.URL != "https://novel.snssdk.com/540.mp4" {
		t.Errorf("封顶 540 应选 540 档，实际 %q (%v)", media.URL, err)
	}
}

// 全部档位都超出上限时退回最小档，保证有画面而不是报错。
func TestSelectHongguoAppMediaFallsBackWhenAllExceedCap(t *testing.T) {
	model := map[string]any{
		"video_list": []any{
			map[string]any{"main_url": "https://novel.snssdk.com/1080.mp4",
				"video_meta": map[string]any{"codec_type": "bytevc1", "vwidth": "1080", "vheight": "1920", "definition": "1080p"}},
			map[string]any{"main_url": "https://novel.snssdk.com/1440.mp4",
				"video_meta": map[string]any{"codec_type": "bytevc1", "vwidth": "1440", "vheight": "2560", "definition": "1440p"}},
		},
	}
	media, err := selectHongguoAppMediaCapped(model, 360)
	if err != nil {
		t.Fatalf("全部超限时应退回最小档而不是报错: %v", err)
	}
	if media.URL != "https://novel.snssdk.com/1080.mp4" {
		t.Errorf("应退回最小的 1080 档，实际 %q", media.URL)
	}
}

// bytevc2 不受支持，封顶逻辑不能把它捞回来当兜底。
func TestSelectHongguoAppMediaCapNeverFallsBackToUnsupportedCodec(t *testing.T) {
	model := map[string]any{
		"video_list": []any{
			map[string]any{"main_url": "https://novel.snssdk.com/vc2-small.mp4",
				"video_meta": map[string]any{"codec_type": "bytevc2", "vwidth": "360", "vheight": "640", "definition": "360p"}},
			map[string]any{"main_url": "https://novel.snssdk.com/vc1-big.mp4",
				"video_meta": map[string]any{"codec_type": "bytevc1", "vwidth": "1080", "vheight": "1920", "definition": "1080p"}},
		},
	}
	media, err := selectHongguoAppMediaCapped(model, 480)
	if err != nil {
		t.Fatalf("应退回受支持的档位: %v", err)
	}
	if media.URL != "https://novel.snssdk.com/vc1-big.mp4" {
		t.Errorf("兜底不能选中 bytevc2，实际 %q", media.URL)
	}
}
