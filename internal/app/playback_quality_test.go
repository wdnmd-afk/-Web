package app

import (
	"strings"
	"testing"
)

// 非法或缺省画质必须回落到默认档，避免任意数值进入 FFmpeg 表达式。
func TestNormalizePlaybackQuality(t *testing.T) {
	for _, valid := range playbackQualityOptions {
		if got := normalizePlaybackQuality(valid); got != valid {
			t.Errorf("合法档位 %d 被改写为 %d", valid, got)
		}
	}
	// 零值来自新建会话或旧会话，必须视作默认档，
	// 否则首次取流会误判「画质已变更」而白丢预缓存。
	for _, invalid := range []int{0, -1, 99, 4320, 1081} {
		if got := normalizePlaybackQuality(invalid); got != playbackMaxHeight {
			t.Errorf("非法档位 %d 应回落到 %d，实际 %d", invalid, playbackMaxHeight, got)
		}
	}
}

// scale 表达式必须按所选档位封顶，且竖屏横屏分别处理短边。
func TestPlaybackScaleFilterFollowsQuality(t *testing.T) {
	filter := playbackScaleFilter(540)
	// 短边 540、长边 960（540*16/9）
	if !strings.Contains(filter, "960,540") || !strings.Contains(filter, "540,960") {
		t.Errorf("540p 表达式未按短边封顶: %s", filter)
	}
	if strings.Contains(filter, "720") || strings.Contains(filter, "1280") {
		t.Errorf("540p 表达式残留默认档尺寸: %s", filter)
	}
	// 非法档位回落默认，仍应是 720/1280
	fallback := playbackScaleFilter(99)
	if !strings.Contains(fallback, "1280,720") || !strings.Contains(fallback, "720,1280") {
		t.Errorf("非法档位未回落到默认尺寸: %s", fallback)
	}
	// 每档都应生成合法且互不相同的表达式
	seen := map[string]bool{}
	for _, quality := range playbackQualityOptions {
		expression := playbackScaleFilter(quality)
		if !strings.HasPrefix(expression, "fps=30,scale=") || !strings.HasSuffix(expression, "setsar=1") {
			t.Errorf("%dp 表达式结构异常: %s", quality, expression)
		}
		if seen[expression] {
			t.Errorf("%dp 与其他档位生成了相同表达式", quality)
		}
		seen[expression] = true
	}
}
