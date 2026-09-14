(() => {
  const node = id => document.getElementById(id);
  // 播放缓冲与跳转参数。原值缓冲仅 30 秒、向后只留 20 秒、防抖 180ms，
  // 导致网络抖动就转圈、轻微回拖也要重启 FFmpeg 转码。
  // 每次跳到未缓冲位置都会重开一路转码进程，所以窗口放大、防抖加长收益明显。
  const TARGET_BUFFER_SECONDS = 120;  // 播放中向前缓冲上限
  const PAUSED_BUFFER_SECONDS = 15;   // 暂停时仍继续缓冲的余量
  const RETAIN_BEHIND_SECONDS = 45;   // 已播部分保留时长，供小幅回拖复用
  const SEEK_DEBOUNCE_MS = 420;       // 连续拖动停手后才重新取流
  const panel = node('playerPanel');
  const video = node('onlineVideo');
  const episodeList = node('playbackEpisodes');
  const statusText = node('playbackStatus');
  const errorText = node('playbackError');
  let dramaID = '';
  let dramaName = '';
  let collectionTaskID = '';
  let collectionMode = false;
  let preparedIndex = 0;
  let sessionID = '';
  let sessionAvailable = false;
  let mimeType = '';
  let episodes = [];
  let episodeButtons = [];
  let currentIndex = 0;
  let openingVersion = 0;
  let streamVersion = 0;
  let openingController = null;
  let streamController = null;
  let objectURL = '';
  let loading = false;
  let heartbeatTimer = null;
  let heartbeatPending = false;
  let seekTimer = null;
  let lastPosition = 0;
  let playbackRun = 0;
  let streamComplete = false;
  let prefetchAttempted = 0;
  let prefetchVersion = 0;
  const prefetchToggle = node('prefetchNextEpisode');
  const prefetchStatus = node('prefetchStatus');
  const stage = node('playbackStage');
  const qualitySelect = node('playbackQuality');
  // 画质档位由后端下发（实测红果提供 360/480/540/720/1080），记住上次选择
  let currentQuality = 720;
  try {
    const saved = Number(localStorage.getItem('juku.playback.quality'));
    if (saved > 0) currentQuality = saved;
  } catch (_) {}
  try {prefetchToggle.checked = localStorage.getItem('juku.playback.prefetchNext') !== 'false';} catch (_) {}

  // 把视频真实分辨率写进舞台的 CSS 变量，让容器按实际比例收窄。
  // 红果短剧多为 720x1280 竖屏，若沿用固定横向容器会在两侧留下大片黑边。
  function applyStageRatio() {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return;
    stage.style.setProperty('--stage-w', String(width));
    stage.style.setProperty('--stage-h', String(height));
  }

  // 换集或重新取流前恢复默认比例，避免上一集的竖屏尺寸残留到下一集首帧之前。
  function resetStageRatio() {
    stage.style.removeProperty('--stage-w');
    stage.style.removeProperty('--stage-h');
  }

  video.addEventListener('loadedmetadata', applyStageRatio);
  video.addEventListener('resize', applyStageRatio);

  function clear(element) {
    while (element.firstChild) element.removeChild(element.firstChild);
  }

  async function requestJSON(path, body, signal) {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {'Accept': 'application/json', 'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
      signal
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || 'HTTP ' + response.status);
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function releaseSession(id) {
    if (!id) return;
    const body = JSON.stringify({session: id, action: 'close'});
    if (navigator.sendBeacon && navigator.sendBeacon('/api/ui/playback/control', new Blob([body], {type: 'application/json'}))) return;
    fetch('/api/ui/playback/control', {method: 'POST', headers: {'Content-Type': 'application/json'}, body, keepalive: true}).catch(() => {});
  }

  function stopStream() {
    window.JukuPlaybackDanmaku?.suspend();
    streamVersion++;
    playbackRun = 0;
    streamComplete = false;
    prefetchAttempted = 0;
    prefetchVersion++;
    prefetchStatus.hidden = true;
    prefetchStatus.textContent = '';
    loading = true;
    clearTimeout(seekTimer);
    if (streamController) streamController.abort();
    streamController = null;
    video.pause();
    video.removeAttribute('src');
    video.load();
    resetStageRatio();
    if (objectURL) URL.revokeObjectURL(objectURL);
    objectURL = '';
  }

  function dispose() {
    panel.classList.remove('pure-mode', 'web-fullscreen');
    openingVersion++;
    if (openingController) openingController.abort();
    openingController = null;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    heartbeatPending = false;
    stopStream();
    releaseSession(sessionID);
    sessionID = '';
    sessionAvailable = false;
    preparedIndex = 0;
    window.JukuPlaybackDanmaku?.close();
  }

  function updateEpisodeControls() {
    node('previousEpisodeBtn').disabled = currentIndex <= 1;
    node('nextEpisodeBtn').disabled = currentIndex < 1 || currentIndex >= episodes.length;
    node('retryPlaybackBtn').disabled = !dramaID && !collectionTaskID;
    episodeButtons.forEach((button, index) => button.setAttribute('aria-current', String(index + 1 === currentIndex)));
    node('playbackEpisodeCount').textContent = episodes.length ? '第 ' + (episodes[currentIndex - 1]?.episode || currentIndex || '—') + ' 集 / 共 ' + episodes.length + ' 集' : '选集';
    // 图标条与外部按钮共享禁用状态，单一来源
    syncStageControls();
    const active = episodeButtons[currentIndex - 1];
    if (active) {
      const item = active.getBoundingClientRect();
      const viewport = episodeList.getBoundingClientRect();
      if (item.top < viewport.top) episodeList.scrollTop -= viewport.top - item.top;
      else if (item.bottom > viewport.bottom) episodeList.scrollTop += item.bottom - viewport.bottom;
    }
  }

  function showError(error) {
    window.JukuPlaybackDanmaku?.suspend();
    loading = false;
    errorText.textContent = (error.message || String(error)) + '；可点击“重试播放”。';
    statusText.textContent = '播放未完成';
    if (error.status === 410) sessionAvailable = false;
    updateEpisodeControls();
  }

  function updateDependency(state, text) {
    if (!panel.open || !openingController || sessionID || errorText.textContent) return;
    if (state.status === 'downloading' || state.status === 'verifying') statusText.textContent = text;
    else if (state.status === 'ready') statusText.textContent = collectionMode ? '正在读取合集分集…' : '正在获取分集…';
  }

  function renderEpisodes() {
    clear(episodeList);
    episodeButtons = episodes.map(episode => {
      const button = document.createElement('button');
      button.className = 'secondary';
      button.textContent = '第' + episode.episode + '集';
      button.title = episode.title || button.textContent;
      button.addEventListener('click', () => playEpisode(episode.index));
      episodeList.appendChild(button);
      return button;
    });
    updateEpisodeControls();
  }

  async function heartbeat() {
    if (!sessionID || heartbeatPending) return;
    const currentSession = sessionID;
    heartbeatPending = true;
    try {
      const state = await requestJSON('/api/ui/playback/control', {session: currentSession, action: 'heartbeat'}, openingController?.signal);
      if (currentSession === sessionID && state.run === playbackRun) renderPrefetchStatus(state.prefetch);
    } catch (error) {
      if (currentSession === sessionID && error.status === 410) {
        sessionAvailable = false;
        clearInterval(heartbeatTimer);
        showError(error);
      }
    } finally {
      if (currentSession === sessionID) heartbeatPending = false;
    }
  }

  async function open(id, title, initialIndex = 1, offset = 0, taskID = '') {
    dispose();
    dramaID = id;
    dramaName = title;
    collectionTaskID = taskID;
    collectionMode = Boolean(taskID);
    episodes = [];
    episodeButtons = [];
    currentIndex = 0;
    lastPosition = offset;
    node('playerTitle').textContent = title;
    statusText.textContent = collectionMode ? '正在读取合集分集…' : '正在获取分集…';
    updatePlaybackHint('');
    errorText.textContent = '';
    clear(episodeList);
    updateEpisodeControls();
    if (!panel.open) panel.showModal();
    if (!window.MediaSource || !MediaSource.isTypeSupported('video/mp4; codecs="avc1.4D401F, mp4a.40.2"')) {
      showError(new Error('当前浏览器不支持此在线播放格式，请使用新版 Chrome、Edge、Firefox 或桌面 Safari'));
      return;
    }
    const version = openingVersion;
    openingController = new AbortController();
    try {
      const result = await requestJSON('/api/ui/playback/open', taskID ? {taskId: taskID} : {dramaId: id}, openingController.signal);
      if (version !== openingVersion || !panel.open) {
        releaseSession(result.session);
        return;
      }
      sessionID = result.session;
      sessionAvailable = true;
      mimeType = result.mimeType;
      collectionMode = result.mode === 'collection';
      episodes = result.episodes || [];
      if (!episodes.length || !MediaSource.isTypeSupported(mimeType)) throw new Error('站点没有可播放的分集或浏览器不支持此格式');
      node('playerTitle').textContent = result.title || title;
      renderEpisodes();
      renderQualityOptions(result.qualityOptions, result.defaultQuality);
      heartbeatTimer = setInterval(heartbeat, 20000);
      playEpisode(Math.min(Math.max(initialIndex || result.initialIndex || 1, 1), episodes.length), offset);
    } catch (error) {
      if (version === openingVersion && error.name !== 'AbortError') showError(error);
    }
  }

  function openCollection(taskID, title) {
    return open('', title, 0, 0, taskID);
  }

  function reopen(index, offset) {
    if (collectionMode) return open('', dramaName, 0, offset, episodes[index - 1]?.taskId || collectionTaskID);
    return open(dramaID, dramaName, index, offset);
  }

  function updatePlaybackHint(source) {
    if (!collectionMode) {
      node('playbackHint').textContent = '直接观看，不加入下载任务。开启预缓存后，临近播完时提前准备下一集；关闭窗口即停止取流并释放缓存。';
    } else {
      const prefix = source === 'local' ? '本集播放本地已完成文件。' : source === 'online' ? '本集在线缓冲，同时使用原下载任务保存视频。' : '已完成分集优先播放本地，播到未完成分集时自动下载该集。';
      node('playbackHint').textContent = prefix + '只补下载播到的分集；关闭播放器不取消下载，可在下载合集中暂停或取消。';
    }
  }

  function abortError() {
    return new DOMException('播放已停止', 'AbortError');
  }

  function waitForEvent(target, eventName, signal, action) {
    return new Promise((resolve, reject) => {
      function cleanup() {
        target.removeEventListener(eventName, done);
        target.removeEventListener('error', failed);
        signal.removeEventListener('abort', aborted);
      }
      function done() {cleanup(); resolve();}
      function failed() {cleanup(); reject(new Error('浏览器无法解码此视频流'));}
      function aborted() {cleanup(); reject(abortError());}
      if (signal.aborted) {aborted(); return;}
      target.addEventListener(eventName, done, {once: true});
      target.addEventListener('error', failed, {once: true});
      signal.addEventListener('abort', aborted, {once: true});
      try {if (action) action();} catch (error) {cleanup(); reject(error);}
    });
  }

  function bufferedAhead() {
    for (let index = 0; index < video.buffered.length; index++) {
      if (video.currentTime >= video.buffered.start(index) && video.currentTime <= video.buffered.end(index)) return video.buffered.end(index) - video.currentTime;
    }
    return 0;
  }

  function renderPrefetchStatus(view) {
    if (!prefetchToggle.checked || !view || view.episode !== currentIndex + 1) return;
    prefetchStatus.hidden = false;
    prefetchStatus.textContent = view.state === 'ready' ? '下一集已缓存' : view.state === 'failed' ? '下一集将正常缓冲' : '正在缓存下一集…';
  }

  function maybePrefetchNext() {
    if (!prefetchToggle.checked || !streamComplete || loading || video.paused || video.ended || video.seeking || !panel.open || !sessionAvailable || !playbackRun || !currentIndex || currentIndex >= episodes.length || prefetchAttempted === currentIndex) return;
    const remaining = video.duration - video.currentTime;
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining / Math.max(video.playbackRate, 0.25) > 30 || bufferedAhead() < remaining - 0.5) return;
    const session = sessionID;
    const run = playbackRun;
    const version = ++prefetchVersion;
    prefetchAttempted = currentIndex;
    renderPrefetchStatus({episode: currentIndex + 1, state: 'preparing'});
    requestJSON('/api/ui/playback/prefetch', {session, episode: currentIndex + 1, run, version}, openingController?.signal).then(view => {
      if (session === sessionID && run === playbackRun && version === prefetchVersion) renderPrefetchStatus(view);
    }).catch(error => {
      if (session === sessionID && run === playbackRun && version === prefetchVersion && error.name !== 'AbortError') renderPrefetchStatus({episode: currentIndex + 1, state: 'failed'});
    });
  }

  prefetchToggle.addEventListener('change', () => {
    try {localStorage.setItem('juku.playback.prefetchNext', String(prefetchToggle.checked));} catch (_) {}
    prefetchAttempted = 0;
    const version = ++prefetchVersion;
    prefetchStatus.hidden = true;
    if (prefetchToggle.checked) {
      maybePrefetchNext();
    } else if (sessionID && playbackRun) {
      requestJSON('/api/ui/playback/prefetch', {session: sessionID, run: playbackRun, version, cancel: true}, openingController?.signal).catch(() => {});
    }
  });

  async function trimBuffer(buffer, signal) {
    const cutoff = video.currentTime - RETAIN_BEHIND_SECONDS;
    if (cutoff > 0 && buffer.buffered.length && buffer.buffered.start(0) < cutoff) {
      await waitForEvent(buffer, 'updateend', signal, () => buffer.remove(0, cutoff));
    }
  }

  async function playEpisode(index, offset = 0, shouldPlay = true) {
    if (!episodes[index - 1]) return;
    if (!sessionAvailable) {reopen(index, offset); return;}
    stopStream();
    currentIndex = index;
    window.JukuPlaybackDanmaku?.setEpisode(sessionID, index, episodes[index - 1].danmaku);
    lastPosition = offset;
    updateEpisodeControls();
    errorText.textContent = '';
    statusText.textContent = offset > 0 ? '正在跳转并缓冲…' : '正在解析播放地址…';
    const version = streamVersion;
    const currentSession = sessionID;
    const controller = new AbortController();
    streamController = controller;
    const signal = controller.signal;
    const source = new MediaSource();
    let reader;
    try {
      if (collectionMode && preparedIndex !== index) {
        statusText.textContent = '正在检查本地分集并准备下载…';
        const preparation = await requestJSON('/api/ui/playback/prepare', {session: currentSession, episode: index}, signal);
        if (signal.aborted) throw abortError();
        preparedIndex = index;
        updatePlaybackHint(preparation.source);
        window.dispatchEvent(new Event('downloadsChanged'));
      }
      objectURL = URL.createObjectURL(source);
      await waitForEvent(source, 'sourceopen', signal, () => {video.src = objectURL;});
      const response = await fetch('/api/ui/playback/stream?' + new URLSearchParams({session: currentSession, episode: String(index), start: String(offset), quality: String(currentQuality)}), {signal, cache: 'no-store'});
      if (!response.ok) {
        const result = await response.json();
        const error = new Error(result.error || 'HTTP ' + response.status);
        error.status = response.status;
        throw error;
      }
      if (signal.aborted) throw abortError();
      updatePlaybackHint(response.headers.get('X-Playback-Source'));
      const duration = Number(response.headers.get('X-Playback-Duration'));
      const run = Number(response.headers.get('X-Playback-Run'));
      playbackRun = run;
      const buffer = source.addSourceBuffer(mimeType);
      buffer.timestampOffset = offset;
      if (duration > 0 && Number.isFinite(duration)) source.duration = duration;
      statusText.textContent = response.headers.get('X-Playback-Prefetched') === '1' ? '正在读取预缓存…' : '正在缓冲…';
      reader = response.body.getReader();
      let initialized = false;
      while (!signal.aborted) {
        while (!signal.aborted && bufferedAhead() > (video.paused && initialized ? PAUSED_BUFFER_SECONDS : TARGET_BUFFER_SECONDS)) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (signal.aborted) throw abortError();
        const chunk = await reader.read();
        if (chunk.done) break;
        await trimBuffer(buffer, signal);
        await waitForEvent(buffer, 'updateend', signal, () => buffer.appendBuffer(chunk.value));
        if (!initialized && buffer.buffered.length) {
          initialized = true;
          video.currentTime = Math.min(buffer.buffered.end(0) - 0.001, Math.max(offset, buffer.buffered.start(0) + 0.03));
          video.playbackRate = Number(node('playbackRate').value) || 1;
          loading = false;
          statusText.textContent = shouldPlay ? '正在播放' : '已暂停';
          if (shouldPlay) video.play().catch(error => {
            if (version !== streamVersion || signal.aborted) return;
            if (error.name === 'NotAllowedError') statusText.textContent = '已就绪，点击视频中的播放按钮';
            else if (error.name !== 'AbortError') showError(error);
          });
        }
      }
      if (signal.aborted) throw abortError();
      const state = await requestJSON('/api/ui/playback/status?session=' + encodeURIComponent(currentSession), undefined, signal);
      if (signal.aborted || version !== streamVersion) throw abortError();
      if (state.run !== run || state.state !== 'ended') throw new Error(state.error || '视频连接中断，请重试');
      if (!initialized) throw new Error('未收到可播放的视频画面');
      if (source.readyState === 'open') source.endOfStream();
      streamComplete = true;
      maybePrefetchNext();
    } catch (error) {
      if (reader) await reader.cancel().catch(() => {});
      if (version === streamVersion && !signal.aborted) showError(error);
    } finally {
      if (reader) reader.releaseLock();
    }
  }

  video.addEventListener('seeking', () => {
    if (loading || !currentIndex || !Number.isFinite(video.currentTime)) return;
    const target = video.currentTime;
    clearTimeout(seekTimer);
    for (let index = 0; index < video.buffered.length; index++) {
      if (target >= video.buffered.start(index) && target < video.buffered.end(index)) return;
    }
    seekTimer = setTimeout(() => playEpisode(currentIndex, target, !video.paused), SEEK_DEBOUNCE_MS);
  });
  video.addEventListener('timeupdate', () => {if (!loading && Number.isFinite(video.currentTime)) lastPosition = video.currentTime; maybePrefetchNext();});
  video.addEventListener('playing', () => {if (!loading && !errorText.textContent) statusText.textContent = '正在播放'; maybePrefetchNext();});
  video.addEventListener('waiting', () => {if (!loading && !errorText.textContent) statusText.textContent = '正在缓冲…';});
  video.addEventListener('pause', () => {if (!loading && !video.ended && !errorText.textContent) statusText.textContent = '已暂停';});
  video.addEventListener('error', () => {
    if (!video.error || !video.hasAttribute('src') || !panel.open) return;
    if (streamController) streamController.abort();
    showError(new Error('浏览器播放失败，请检查网络或重试（错误 ' + video.error.code + '）'));
  });
  video.addEventListener('ended', () => {
    if (loading || !panel.open || errorText.textContent) return;
    if (node('autoNextEpisode').checked && currentIndex < episodes.length) playEpisode(currentIndex + 1);
    else statusText.textContent = '本集播放完毕';
  });
  node('previousEpisodeBtn').addEventListener('click', () => playEpisode(currentIndex - 1));
  node('nextEpisodeBtn').addEventListener('click', () => playEpisode(currentIndex + 1));
  node('retryPlaybackBtn').addEventListener('click', () => {
    preparedIndex = 0;
    if (episodes.length && sessionAvailable) playEpisode(currentIndex || 1, lastPosition);
    else reopen(currentIndex || 1, lastPosition);
  });
  node('playbackRate').addEventListener('change', () => {video.playbackRate = Number(node('playbackRate').value) || 1;});
  // 渲染清晰度档位。实际可用档位由后端决定，这里只做展示与切换。
  function renderQualityOptions(options, fallback) {
    const list = Array.isArray(options) && options.length ? options : [360, 480, 540, 720, 1080];
    if (!list.includes(currentQuality)) currentQuality = fallback || 720;
    clear(qualitySelect);
    for (const value of list) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = value + 'p';
      if (value === currentQuality) option.selected = true;
      qualitySelect.appendChild(option);
    }
  }

  // 切清晰度必须重新取流：转码档位在后端决定，无法中途变更。
  // 保留当前进度和播放状态，体感接近一次跳转。
  qualitySelect.addEventListener('change', () => {
    const value = Number(qualitySelect.value) || 720;
    if (value === currentQuality) return;
    currentQuality = value;
    try {localStorage.setItem('juku.playback.quality', String(value));} catch (_) {}
    if (currentIndex) playEpisode(currentIndex, lastPosition, !video.paused);
  });

  // 画中画：浏览器原生悬浮窗，可拖动缩放，切到别的窗口仍继续播放。
  const pipButton = node('pipBtn');
  const pipSupported = Boolean(document.pictureInPictureEnabled && video.requestPictureInPicture);
  pipButton.hidden = !pipSupported;
  if (pipSupported) {
    pipButton.addEventListener('click', async () => {
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else await video.requestPictureInPicture();
      } catch (_) {
        statusText.textContent = '浏览器拒绝了画中画请求';
      }
    });
    video.addEventListener('enterpictureinpicture', () => {pipButton.textContent = '退出画中画';});
    video.addEventListener('leavepictureinpicture', () => {pipButton.textContent = '画中画';});
  }

  // 网页全屏：铺满浏览器视口但保留标签栏地址栏，区别于占满显示器的原生全屏。
  function setWebFullscreen(on) {
    panel.classList.toggle('web-fullscreen', on);
    if (on) panel.classList.remove('pure-mode');
    applyStageRatio();
    // 状态变更集中在此同步图标，避免外部按钮和 Esc 退出漏刷
    syncStageControls();
  }
  node('webFullscreenBtn').addEventListener('click', () => setWebFullscreen(true));

  // 纯净模式：只切换 CSS class，画面尺寸由 --stage-cap 自动变化。
  // 不用换播放器——播放、进度、音量、倍速、全屏都是 <video controls> 的原生控件。
  function setPureMode(on) {
    panel.classList.toggle('pure-mode', on);
    if (on) panel.classList.remove('web-fullscreen');
    // 切换后容器尺寸变了，重算一次比例，避免画面留白
    applyStageRatio();
    // 同上：集中同步，两种模式互斥，图标需一起刷新
    syncStageControls();
  }
  node('pureModeBtn').addEventListener('click', () => setPureMode(true));
  // Esc 在纯净模式下先退出纯净，不直接关掉播放器
  panel.addEventListener('cancel', event => {
    // Esc 分层退出：先退网页全屏，再退纯净，最后才关播放器
    if (panel.classList.contains('web-fullscreen')) {
      event.preventDefault();
      setWebFullscreen(false);
    } else if (panel.classList.contains('pure-mode')) {
      event.preventDefault();
      setPureMode(false);
    }
  });
  node('closePlayerBtn').addEventListener('click', () => panel.close());
  panel.addEventListener('close', dispose);
  window.addEventListener('pagehide', dispose);
  // ===== 画面内图标工具条 =====
  // 不重复实现逻辑：图标条只是另一组入口，操作后转发给既有控件，
  // 由它们完成重新取流、localStorage 记忆等既有行为，状态单一来源。
  const stageControls = node('stageControls');
  const stageRate = node('stageRate');
  const stageQuality = node('stageQuality');
  const icoPlay = node('icoPlayBtn');
  const icoPip = node('icoPipBtn');
  const icoExpand = node('icoExpandBtn');
  const icoPure = node('icoPureBtn');
  const icoFull = node('icoFullBtn');

  function useIcon(button, id) {
    const use = button.querySelector('use');
    if (use) use.setAttribute('href', '#' + id);
  }

  // 从既有 select 克隆选项，保证档位来源单一
  function mirrorOptions(source, target) {
    clear(target);
    for (const option of source.options) {
      const copy = document.createElement('option');
      copy.value = option.value;
      copy.textContent = option.textContent;
      copy.selected = option.selected;
      target.appendChild(copy);
    }
  }

  function syncStageControls() {
    mirrorOptions(node('playbackRate'), stageRate);
    mirrorOptions(qualitySelect, stageQuality);
    node('icoPrevBtn').disabled = node('previousEpisodeBtn').disabled;
    node('icoNextBtn').disabled = node('nextEpisodeBtn').disabled;
    node('icoReloadBtn').disabled = node('retryPlaybackBtn').disabled;
    icoPip.hidden = node('pipBtn').hidden;
    useIcon(icoPlay, video.paused ? 'icoPlay' : 'icoPause');
    useIcon(icoExpand, panel.classList.contains('web-fullscreen') ? 'icoCollapse' : 'icoExpand');
    icoExpand.title = panel.classList.contains('web-fullscreen') ? '退出网页全屏' : '网页全屏';
    // 纯净模式会隐藏外部工具栏，退出入口只能留在图标条上
    const pure = panel.classList.contains('pure-mode');
    useIcon(icoPure, pure ? 'icoPureOff' : 'icoPure');
    icoPure.title = pure ? '退出纯净模式' : '纯净模式';
    // 原生全屏：可见性跟随外部按钮（由 player-danmaku.js 按浏览器支持情况决定）
    icoFull.hidden = node('playerFullscreenBtn').hidden;
    const native = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
    useIcon(icoFull, native ? 'icoFullExit' : 'icoFull');
    icoFull.title = native ? '退出全屏' : '全屏';
  }

  node('icoPrevBtn').addEventListener('click', () => node('previousEpisodeBtn').click());
  node('icoNextBtn').addEventListener('click', () => node('nextEpisodeBtn').click());
  node('icoReloadBtn').addEventListener('click', () => node('retryPlaybackBtn').click());
  icoPip.addEventListener('click', () => node('pipBtn').click());
  icoPlay.addEventListener('click', () => {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  });
  node('icoCloseBtn').addEventListener('click', () => panel.close());
  // 同一个按钮兼作进入与退出，图标随状态切换
  icoExpand.addEventListener('click', () => setWebFullscreen(!panel.classList.contains('web-fullscreen')));
  icoPure.addEventListener('click', () => setPureMode(!panel.classList.contains('pure-mode')));
  // 原生全屏逻辑由 player-danmaku.js 持有（它同时管弹幕层的重排），这里只借用
  icoFull.addEventListener('click', () => window.JukuNativeFullscreen?.());
  for (const event of ['fullscreenchange', 'webkitfullscreenchange']) {
    document.addEventListener(event, syncStageControls);
  }
  // 下拉改动同步回原控件并触发 change，走原有的重新取流逻辑
  stageRate.addEventListener('change', () => {
    const original = node('playbackRate');
    original.value = stageRate.value;
    original.dispatchEvent(new Event('change'));
  });
  stageQuality.addEventListener('change', () => {
    qualitySelect.value = stageQuality.value;
    qualitySelect.dispatchEvent(new Event('change'));
  });

  // 鼠标静止或移出画面后淡出图标条，避免长期遮挡画面。
  // 暂停时保持可见，方便继续操作。
  let idleTimer = null;
  function wakeControls() {
    stage.classList.remove('stage-idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (video.paused) return;
      // 指针悬停在条上或正在操作下拉时不隐藏
      if (!stageControls.matches(':hover') && !stage.matches(':focus-within')) {
        stage.classList.add('stage-idle');
      }
    }, 2600);
  }
  for (const event of ['pointermove', 'pointerdown', 'keydown']) {
    stage.addEventListener(event, wakeControls);
  }
  stage.addEventListener('pointerleave', () => {
    clearTimeout(idleTimer);
    if (!video.paused && !stage.matches(':focus-within')) stage.classList.add('stage-idle');
  });
  video.addEventListener('pause', () => {wakeControls(); syncStageControls();});
  video.addEventListener('play', () => {wakeControls(); syncStageControls();});
  video.addEventListener('playing', syncStageControls);
  syncStageControls();
  wakeControls();

  window.dramaPlayer = {open, openCollection, updateDependency};
})();
