package app

import (
	"io"
	"sync"
	"time"
)

// playbackRateWindow 是网速统计的采样窗口：窗口内累计字节，满一窗结算一次速率。
const playbackRateWindow = time.Second

// playbackRateMeter 统计单向字节速率，供界面显示实时网速。
// 停止读写时读数按已过时间衰减趋向 0，不会停在旧数字上误导判断。
type playbackRateMeter struct {
	mu          sync.Mutex
	total       int64
	windowBytes int64
	windowStart time.Time
	rate        float64
}

func (meter *playbackRateMeter) add(count int) {
	if meter == nil || count <= 0 {
		return
	}
	now := time.Now()
	meter.mu.Lock()
	defer meter.mu.Unlock()
	if meter.windowStart.IsZero() {
		meter.windowStart = now
	}
	meter.total += int64(count)
	meter.windowBytes += int64(count)
	if elapsed := now.Sub(meter.windowStart); elapsed >= playbackRateWindow {
		meter.rate = float64(meter.windowBytes) / elapsed.Seconds()
		meter.windowBytes = 0
		meter.windowStart = now
	}
}

// snapshot 返回累计字节与当前速率。当前窗口已超时仍没有结算时，
// 按实际经过时间重算，使停顿时读数趋向 0 而不是保留上一次的值。
func (meter *playbackRateMeter) snapshot() (int64, float64) {
	if meter == nil {
		return 0, 0
	}
	now := time.Now()
	meter.mu.Lock()
	defer meter.mu.Unlock()
	rate := meter.rate
	if !meter.windowStart.IsZero() {
		if elapsed := now.Sub(meter.windowStart); elapsed >= playbackRateWindow {
			rate = float64(meter.windowBytes) / elapsed.Seconds()
		}
	}
	return meter.total, rate
}

// playbackMeters 是一路播放流的网速统计：upstream 为后端从站点拉取的字节，
// output 为转码后写给浏览器的字节。两者分开才能区分「网络慢」与「本机转码慢」。
type playbackMeters struct {
	upstream playbackRateMeter
	output   playbackRateMeter
	// local 为真表示播放本地已下载文件，没有上游流量，界面显示「本地」而非 0。
	// 由取流协程写、状态接口读，故用 mu 保护。
	mu    sync.Mutex
	local bool
}

// markLocal 标记本路为本地文件播放，没有上游拉流。
func (meters *playbackMeters) markLocal() {
	if meters == nil {
		return
	}
	meters.mu.Lock()
	meters.local = true
	meters.mu.Unlock()
}

// addOutput 累计转码后写给浏览器的字节。
func (meters *playbackMeters) addOutput(count int) {
	if meters == nil {
		return
	}
	meters.output.add(count)
}

type playbackMetersView struct {
	UpstreamBytes int64   `json:"upstreamBytes"`
	UpstreamRate  float64 `json:"upstreamRate"`
	OutputBytes   int64   `json:"outputBytes"`
	OutputRate    float64 `json:"outputRate"`
	Local         bool    `json:"local"`
}

func (meters *playbackMeters) view() *playbackMetersView {
	if meters == nil {
		return nil
	}
	upstreamBytes, upstreamRate := meters.upstream.snapshot()
	outputBytes, outputRate := meters.output.snapshot()
	meters.mu.Lock()
	local := meters.local
	meters.mu.Unlock()
	return &playbackMetersView{
		UpstreamBytes: upstreamBytes,
		UpstreamRate:  upstreamRate,
		OutputBytes:   outputBytes,
		OutputRate:    outputRate,
		Local:         local,
	}
}

// meteredReader 统计经过的字节数，不改变原有读取语义与错误传递。
type meteredReader struct {
	reader io.Reader
	meter  *playbackRateMeter
}

func (reader *meteredReader) Read(buffer []byte) (int, error) {
	count, err := reader.reader.Read(buffer)
	reader.meter.add(count)
	return count, err
}
