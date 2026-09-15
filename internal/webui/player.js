(() => {
  const node = id => document.getElementById(id);
  // 播放缓冲与跳转参数。原值缓冲仅 30 秒、向后只留 20 秒、防抖 180ms，
  // 导致网络抖动就转圈、轻微回拖也要重启 FFmpeg 转码。
  // 每次跳到未缓冲位置都会重开一路转码进程，所以窗口放大、防抖加长收益明显。
  const TARGET_BUFFER_SECONDS = 120;  // 播放中向前缓冲上限
  const PAUSED_BUFFER_SECONDS = 15;   // 暂停时仍继续缓冲的余量
  const RETAIN_BEHIND_SECONDS = 45;   // 已播部分保留时长，供小幅回拖复用
  const SEEK_DEBOUNCE_MS = 420;       // 连续拖动停手后才重新取流
  const SEEK_STEP_SECONDS = 5;        // 方向键快进快退步长
  const PROGRESS_REPORT_MS = 5000;    // 观看进度上报间隔
  const METER_POLL_MS = 1000;         // 网速读数刷新间隔
  const AUTO_RETRY_LIMIT = 2;         // 取流失败自动重试次数
  const panel = node('playerView');
  const video = node('onlineVideo');
  const episodeList = node('playbackEpisodes');
  const statusText = node('playbackStatus');
  const errorText = node('playbackError');
  const overlay = node('stageOverlay');
  const overlayText = node('stageOverlayText');
  const stageToast = node('stageToast');
  let isOpen = false;
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
  let meterTimer = null;
  let meterPending = false;
  let seekTimer = null;
  let lastPosition = 0;
  let knownDuration = 0;
  let playbackRun = 0;
  let streamComplete = false;
  let prefetchAttempted = 0;
  let prefetchVersion = 0;
  let retryCount = 0;
  let retryTimer = null;
  let lastReportAt = 0;
  let toastTimer = null;
  let floating = false;                      // 小窗模式是否开启
  let stageEpisodeButtons = [];              // 画面内选集面板里的按钮，与侧栏选集一一对应
  let episodesOpen = false;                  // 画面内选集面板是否展开
  const windows = window.JukuWindows || null;
  const windowMode = Boolean(windows && windows.isWindow);   // 独立播放窗口：没有导航，关闭即关窗口
  const windowMini = Boolean(windows && windows.mode === 'mini'); // 紧凑小窗：画面始终铺满窗口
  const floatRect = {x: NaN, y: NaN, w: 0, h: 0};
  const FLOAT_MIN_WIDTH = 220;
  const FLOAT_MARGIN = 8;
  const prefetchToggle = node('prefetchNextEpisode');
  const prefetchStatus = node('prefetchStatus');
  const stage = node('playbackStage');
  const qualitySelect = node('playbackQuality');
  const rateSelect = node('playbackRate');
  const autoNextToggle = node('autoNextEpisode');
  const netMeter = node('netMeter');
  // 网速读数分两段，上游单独用 <b class="net-up"> 包裹，卡顿时只标红上游那一段。
  // 元素只建一次、之后只改文本，避免每秒重建 DOM。
  const netUpstream = document.createElement('b');
  netUpstream.className = 'net-up';
  const netOutput = document.createElement('b');
  // ===== 偏好记忆：画质、预缓存、倍速、自动连播、音量 =====
  // 画质档位由后端下发（实测红果提供 360/480/540/720/1080），记住上次选择
  let currentQuality = 720;
  const store = {
    get(key) {try {return localStorage.getItem(key);} catch (_) {return null;}},
    set(key, value) {try {localStorage.setItem(key, String(value));} catch (_) {}}
  };
  {
    const saved = Number(store.get('juku.playback.quality'));
    if (saved > 0) currentQuality = saved;
    prefetchToggle.checked = store.get('juku.playback.prefetchNext') !== 'false';
    autoNextToggle.checked = store.get('juku.playback.autoNext') !== 'false';
    const rate = store.get('juku.playback.rate');
    if (rate && Array.from(rateSelect.options).some(option => option.value === rate)) rateSelect.value = rate;
    const volume = Number(store.get('juku.playback.volume'));
    if (Number.isFinite(volume) && volume >= 0 && volume <= 1 && store.get('juku.playback.volume') !== null) video.volume = volume;
    video.muted = store.get('juku.playback.muted') === 'true';
  }
  autoNextToggle.addEventListener('change', () => store.set('juku.playback.autoNext', autoNextToggle.checked));
  video.addEventListener('volumechange', () => {store.set('juku.playback.volume', video.volume.toFixed(2)); store.set('juku.playback.muted', video.muted);});

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

  // ===== 画面遮罩：加载 / 缓冲时显示转圈与说明，播放中隐藏 =====
  function showOverlay(text) {
    overlay.hidden = false;
    overlayText.textContent = text || '正在加载…';
  }
  function hideOverlay() {
    overlay.hidden = true;
  }
  function setStatus(text, withOverlay) {
    statusText.textContent = text;
    if (withOverlay) showOverlay(text);
  }
  function toast(text, duration = 2600) {
    clearTimeout(toastTimer);
    stageToast.textContent = text;
    stageToast.hidden = !text;
    if (text) toastTimer = setTimeout(() => {stageToast.hidden = true;}, duration);
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

  // ===== 观看进度上报 =====
  function currentDuration() {
    if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
    return knownDuration || 0;
  }
  function historyPayload(finished) {
    if (!dramaID || !currentIndex || !episodes[currentIndex - 1]) return null;
    const info = window.appShell?.dramaInfo?.(dramaID) || {};
    const position = finished ? currentDuration() : lastPosition;
    return {
      dramaId: dramaID, title: dramaName || info.title || '', cover: info.cover || '', channel: info.channel || '',
      episodeCount: episodes.length || info.episodeCount || 0, mode: collectionMode ? 'collection' : 'online', taskId: collectionMode ? collectionTaskID : '',
      index: currentIndex, episode: episodes[currentIndex - 1].episode || String(currentIndex),
      position: Math.max(0, Math.round((position || 0) * 10) / 10), duration: Math.round(currentDuration() * 10) / 10, finished: Boolean(finished)
    };
  }
  function reportProgress(options = {}) {
    if (!window.JukuHistory) return;
    const now = Date.now();
    if (!options.force && now - lastReportAt < PROGRESS_REPORT_MS) return;
    const payload = historyPayload(options.finished);
    if (!payload || (!options.force && payload.position < 1)) return;
    lastReportAt = now;
    window.JukuHistory.report(payload, options.beacon);
    markEpisodeProgress(currentIndex);
  }

  function stopStream() {
    window.JukuPlaybackDanmaku?.suspend();
    clearTimeout(retryTimer);
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
    panel.classList.remove('pure-mode');
    // 紧凑小窗的画面始终铺满窗口，不随会话重开而退出网页全屏
    if (!windowMini) panel.classList.remove('web-fullscreen');
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
    openingVersion++;
    if (openingController) openingController.abort();
    openingController = null;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    heartbeatPending = false;
    stopMeters();
    stopStream();
    hideOverlay();
    toast('');
    releaseSession(sessionID);
    sessionID = '';
    sessionAvailable = false;
    preparedIndex = 0;
    retryCount = 0;
    window.JukuPlaybackDanmaku?.close();
  }

  function updateEpisodeControls() {
    node('previousEpisodeBtn').disabled = currentIndex <= 1;
    node('nextEpisodeBtn').disabled = currentIndex < 1 || currentIndex >= episodes.length;
    node('retryPlaybackBtn').disabled = !dramaID && !collectionTaskID;
    episodeButtons.forEach((button, index) => button.setAttribute('aria-current', String(index + 1 === currentIndex)));
    stageEpisodeButtons.forEach((button, index) => button.setAttribute('aria-current', String(index + 1 === currentIndex)));
    node('playbackEpisodeCount').textContent = episodes.length ? '第 ' + (episodes[currentIndex - 1]?.episode || currentIndex || '—') + ' 集 / 共 ' + episodes.length + ' 集' : '';
    node('playbackEpisodeTotal').textContent = episodes.length ? '共 ' + episodes.length + ' 集' : '';
    node('stageEpisodesTotal').textContent = node('playbackEpisodeTotal').textContent;
    // 图标条与外部按钮共享禁用状态，单一来源
    syncStageControls();
    scrollEpisodeIntoView(episodeList, episodeButtons[currentIndex - 1]);
    if (episodesOpen) scrollEpisodeIntoView(stageEpisodeList, stageEpisodeButtons[currentIndex - 1]);
    syncTitle();
  }

  function scrollEpisodeIntoView(list, button) {
    if (!button) return;
    const item = button.getBoundingClientRect();
    const viewport = list.getBoundingClientRect();
    if (item.top < viewport.top) list.scrollTop -= viewport.top - item.top;
    else if (item.bottom > viewport.bottom) list.scrollTop += item.bottom - viewport.bottom;
  }

  function showError(error) {
    window.JukuPlaybackDanmaku?.suspend();
    loading = false;
    hideOverlay();
    errorText.textContent = (error.message || String(error)) + '；可点击“重试播放”。';
    statusText.textContent = '播放未完成';
    if (error.status === 410) sessionAvailable = false;
    updateEpisodeControls();
  }

  function updateDependency(state, text) {
    if (!isOpen || !openingController || sessionID || errorText.textContent) return;
    if (state.status === 'downloading' || state.status === 'verifying') setStatus(text, true);
    else if (state.status === 'ready') setStatus(collectionMode ? '正在读取合集分集…' : '正在获取分集…', true);
  }

  // 选集按钮上的进度标记：看完打勾，看了一部分显示底部进度条。侧栏与画面内两份列表同步。
  function markEpisodeProgress(index) {
    if (!window.JukuHistory) return;
    const record = dramaID ? window.JukuHistory.episodeRecord(dramaID, index) : null;
    const finished = Boolean(record && record.finished);
    const percent = record && !record.finished && record.duration > 0 ? Math.min(100, Math.round(record.position / record.duration * 100)) : 0;
    for (const button of [episodeButtons[index - 1], stageEpisodeButtons[index - 1]]) {
      if (!button) continue;
      button.classList.toggle('watched', finished);
      button.style.setProperty('--p', percent + '%');
      button.classList.toggle('partial', percent > 0);
    }
  }

  function episodeButton(episode, container) {
    const button = document.createElement('button');
    button.className = 'secondary';
    button.textContent = episode.episode;
    button.title = (episode.title || '第' + episode.episode + '集');
    button.addEventListener('click', () => {
      playEpisode(episode.index, episodeStartOffset(episode.index));
      // 小窗和窄窗口里面板遮住大半画面，选完就收起
      if (episodesOpen && (floating || stage.clientWidth < 520)) setEpisodesPanel(false);
    });
    container.appendChild(button);
    return button;
  }

  function renderEpisodes() {
    clear(episodeList);
    clear(stageEpisodeList);
    episodeButtons = episodes.map(episode => episodeButton(episode, episodeList));
    stageEpisodeButtons = episodes.map(episode => episodeButton(episode, stageEpisodeList));
    episodeButtons.forEach((_, index) => markEpisodeProgress(index + 1));
    updateEpisodeControls();
  }

  // ===== 画面内选集侧边窗：半透明面板，全屏、纯净、小窗和独立窗口里也能选集 =====
  const stageEpisodes = node('stageEpisodes');
  const stageEpisodeList = node('stageEpisodeList');
  const icoEpisodes = node('icoEpisodesBtn');
  function setEpisodesPanel(on) {
    episodesOpen = Boolean(on);
    stageEpisodes.classList.toggle('open', episodesOpen);
    icoEpisodes.setAttribute('aria-pressed', String(episodesOpen));
    icoEpisodes.title = episodesOpen ? '收起选集（E）' : '选集（E）';
    if (episodesOpen) {
      scrollEpisodeIntoView(stageEpisodeList, stageEpisodeButtons[currentIndex - 1]);
      wakeControls();
    } else {
      stage.focus({preventScroll: true});
    }
  }
  icoEpisodes.addEventListener('click', () => setEpisodesPanel(!episodesOpen));
  node('stageEpisodesClose').addEventListener('click', () => setEpisodesPanel(false));

  // 画面变窄时（小窗、独立小窗、窄屏）收起次要按钮，图标条才放得下
  if (window.ResizeObserver) {
    new ResizeObserver(entries => {
      const width = entries[0]?.contentRect?.width || stage.clientWidth;
      stage.classList.toggle('stage-narrow', width < 640);
      stage.classList.toggle('stage-tiny', width < 440);
    }).observe(stage);
  }

  function episodeStartOffset(index) {
    return dramaID && window.JukuHistory ? window.JukuHistory.episodeOffset(dramaID, index) : 0;
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

  function formatRate(bytesPerSecond) {
    const value = Number(bytesPerSecond) || 0;
    if (value >= 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' MB/s';
    return Math.round(value / 1024) + ' KB/s';
  }

  // 两个数字分别回答不同的问题：
  // 上游 = 后端从红果拉分片的速度，反映网络；转码 = FFmpeg 写给浏览器的速度，受 CPU 限制。
  // 两者的码率本来就不同（上游是源站 H.265，转码是 H.264），所以不做比值判断，
  // 只在明显停顿时标红：正在播却几乎没有上游流量，才是真的卡在网络上。
  function renderMeters(view) {
    if (!view) {netMeter.hidden = true; return;}
    netMeter.hidden = false;
    // 首次渲染时装配结构：上游 <b> · 转码 <b>，之后只更新两个 <b> 的文本。
    if (!netMeter.contains(netUpstream)) {
      netMeter.textContent = '';
      netMeter.append('上游 ', netUpstream, ' · 转码 ', netOutput);
    }
    netOutput.textContent = formatRate(view.outputRate);
    if (view.local) {
      netUpstream.textContent = '本地';
      netMeter.classList.remove('net-slow');
      return;
    }
    netUpstream.textContent = formatRate(view.upstreamRate);
    // 正在播却几乎没有上游流量，才判定卡在网络上。
    // 暂停时不判定：暂停后缓冲很快填满，上游本就该降到 0。
    const stalled = !video.paused && Number(view.upstreamRate) < 20 * 1024 && Number(view.outputRate) < 20 * 1024;
    netMeter.classList.toggle('net-slow', stalled);
  }

  async function pollMeters() {
    if (!sessionID || meterPending) return;
    const currentSession = sessionID;
    meterPending = true;
    try {
      const state = await requestJSON('/api/ui/playback/status?session=' + encodeURIComponent(currentSession), undefined, openingController?.signal);
      if (currentSession === sessionID) renderMeters(state.meters);
    } catch (error) {
      if (currentSession === sessionID && error.status === 410) stopMeters();
    } finally {
      if (currentSession === sessionID) meterPending = false;
    }
  }

  function startMeters() {
    if (meterTimer) return;
    meterTimer = setInterval(pollMeters, METER_POLL_MS);
    pollMeters();
  }

  function stopMeters() {
    clearInterval(meterTimer);
    meterTimer = null;
    meterPending = false;
    netMeter.hidden = true;
    netMeter.classList.remove('net-slow');
  }

  // 窗口标题跟随正在播放的剧与集数，开了几个窗口在任务栏里也分得清。
  // 画面内右下角也放一份：纯净/全屏/网页全屏模式下 player-bar 被隐藏，
  // 没有这一份的话画面上就完全看不到自己在看哪部哪集。
  function syncTitle() {
    const base = '果果剧库';
    let title = base;
    let info = '';
    if (isOpen && dramaName) {
      const label = episodes[currentIndex - 1]?.episode;
      title = dramaName + (label ? ' 第' + label + '集' : '') + ' - ' + base;
      // 与工具栏 playbackEpisodeCount 同一口径：分集号缺失时回退用序号
      info = dramaName + ' · 第 ' + (label || currentIndex || '—') + ' 集 / 共 ' + (episodes.length || '—') + ' 集';
    }
    if (windows) windows.setTitle(title); else document.title = title;
    const stageInfo = node('stageInfo');
    stageInfo.textContent = info;
    // 标题过长被省略号截断时，悬停仍能看全
    stageInfo.title = info;
  }

  function showPlayerView() {
    if (!isOpen) {
      isOpen = true;
      window.appShell?.showView('player');
    }
    stage.focus({preventScroll: true});
  }

  // initialIndex 为 0 表示由观看历史决定从哪一集、哪个位置开始。
  async function open(id, title, initialIndex = 0, offset = 0, taskID = '', historyID = '') {
    reportProgress({force: true});
    dispose();
    dramaID = id || historyID || '';
    dramaName = title;
    collectionTaskID = taskID;
    collectionMode = Boolean(taskID);
    episodes = [];
    episodeButtons = [];
    currentIndex = 0;
    lastPosition = offset;
    knownDuration = 0;
    node('playerTitle').textContent = title;
    setStatus(collectionMode ? '正在读取合集分集…' : '正在获取分集…', true);
    updatePlaybackHint('');
    errorText.textContent = '';
    clear(episodeList);
    updateEpisodeControls();
    // 记住了小窗模式就直接以悬浮窗打开，停留在当前页面；独立窗口里没有小窗模式
    if (floating) {isOpen = true; window.appShell?.refreshViews?.();}
    else if (floatPref.on && !windowMode) {isOpen = true; setFloat(true);}
    else showPlayerView();
    window.appShell?.renderPlayerInfo(dramaID, title, collectionMode ? 'collection' : 'online');
    if (!window.MediaSource || !MediaSource.isTypeSupported('video/mp4; codecs="avc1.4D401F, mp4a.40.2"')) {
      showError(new Error('当前浏览器不支持此在线播放格式，请使用新版 Chrome、Edge、Firefox 或桌面 Safari'));
      return;
    }
    const version = openingVersion;
    openingController = new AbortController();
    try {
      const result = await requestJSON('/api/ui/playback/open', taskID ? {taskId: taskID} : {dramaId: id}, openingController.signal);
      if (version !== openingVersion || !isOpen) {
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
      dramaName = result.title || title;
      renderEpisodes();
      renderQualityOptions(result.qualityOptions, result.defaultQuality);
      heartbeatTimer = setInterval(heartbeat, 20000);
      startMeters();
      let startIndex = initialIndex;
      let startOffset = offset;
      if (!startIndex && dramaID && window.JukuHistory) {
        const resume = window.JukuHistory.resumeFor(dramaID, episodes.length);
        if (resume) {
          startIndex = resume.index;
          startOffset = resume.offset;
          const label = episodes[startIndex - 1]?.episode || startIndex;
          if (resume.reason === 'resume') toast(startOffset > 0 ? '从上次 第 ' + label + ' 集 ' + window.JukuHistory.formatClock(startOffset) + ' 继续播放' : '接着播放第 ' + label + ' 集', 3500);
          else if (resume.reason === 'next') toast('上次已看完第 ' + (episodes[resume.index - 2]?.episode || resume.index - 1) + ' 集，继续播放第 ' + label + ' 集', 3500);
        }
      }
      if (!startIndex) startIndex = result.initialIndex || 1;
      playEpisode(Math.min(Math.max(startIndex, 1), episodes.length), startOffset);
    } catch (error) {
      if (version === openingVersion && error.name !== 'AbortError') showError(error);
    }
  }

  function openCollection(taskID, title, dramaId = '', index = 0, offset = 0) {
    return open('', title, index, offset, taskID, dramaId);
  }

  function reopen(index, offset) {
    if (collectionMode) return open('', dramaName, index, offset, episodes[index - 1]?.taskId || collectionTaskID, dramaID);
    return open(dramaID, dramaName, index, offset);
  }

  function updatePlaybackHint(source) {
    if (!collectionMode) {
      node('playbackHint').textContent = '直接观看，不加入下载任务。观看进度自动记录到历史，下次打开从上次位置继续；关闭播放即停止取流并释放缓存。';
    } else {
      const prefix = source === 'local' ? '本集播放本地已完成文件。' : source === 'online' ? '本集在线缓冲，同时使用原下载任务保存视频。' : '已完成分集优先播放本地，播到未完成分集时自动下载该集。';
      node('playbackHint').textContent = prefix + '只补下载播到的分集；离开播放器不取消下载，可在下载页暂停或取消。';
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

  // bufferTargetSeconds 把缓冲目标按倍速折算。
  // buffered 里的秒数是「视频时间」，倍速播放会成倍地快速消耗：
  // 3 倍速下固定的 120 秒只等效 40 秒真实时间，而 FFmpeg 大致按 1 倍速产出，
  // 于是必然边播边等。按倍速放大目标，真实时间的余量才保持不变。
  // 上限取基准的 3 倍，避免高倍速下 MediaSource 占用无节制增长。
  // paused 由调用方传入：首帧就绪前 video.paused 本就为真，
  // 若在此直接读它会把初次缓冲目标降到暂停档，白白截短首帧前的缓冲。
  function bufferTargetSeconds(paused) {
    const base = paused ? PAUSED_BUFFER_SECONDS : TARGET_BUFFER_SECONDS;
    const rate = Math.max(Number(video.playbackRate) || 1, 1);
    return base * Math.min(rate, 3);
  }

  function renderPrefetchStatus(view) {
    if (!prefetchToggle.checked || !view || view.episode !== currentIndex + 1) return;
    prefetchStatus.hidden = false;
    prefetchStatus.textContent = view.state === 'ready' ? '下一集已缓存' : view.state === 'failed' ? '下一集将正常缓冲' : '正在缓存下一集…';
  }

  function maybePrefetchNext() {
    if (!prefetchToggle.checked || !streamComplete || loading || video.paused || video.ended || video.seeking || !isOpen || !sessionAvailable || !playbackRun || !currentIndex || currentIndex >= episodes.length || prefetchAttempted === currentIndex) return;
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
    store.set('juku.playback.prefetchNext', prefetchToggle.checked);
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

  // 网络类失败自动重试，会话失效或参数错误则直接报错交给用户。
  function retryable(error) {
    if (!error || error.name === 'AbortError') return false;
    if (error.status && error.status < 500 && error.status !== 408 && error.status !== 429) return false;
    return true;
  }

  function failStream(error, index, shouldPlay) {
    if (retryable(error) && retryCount < AUTO_RETRY_LIMIT) {
      retryCount++;
      const attempt = retryCount;
      const version = streamVersion;
      setStatus('连接中断，' + (attempt * 1.5).toFixed(1).replace('.0', '') + ' 秒后自动重试（' + attempt + '/' + AUTO_RETRY_LIMIT + '）…', true);
      window.JukuPlaybackDanmaku?.suspend();
      retryTimer = setTimeout(() => {
        if (version !== streamVersion || !isOpen) return;
        preparedIndex = 0;
        playEpisode(index, lastPosition, shouldPlay);
      }, 1500 * attempt);
      return;
    }
    showError(error);
  }

  // 独立窗口刚打开时没有用户操作记录，浏览器会拒绝自动出声播放。
  // 桌面子窗口让宿主代替用户点一下画面中心，页面的点击处理随即开始播放；每个窗口只请求一次。
  let hostClickRequested = false;
  function requestHostClick() {
    if (hostClickRequested || !windows || !windowMode) return;
    hostClickRequested = true;
    setTimeout(() => {
      if (!isOpen || !video.paused || loading) return;
      const rect = video.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const scale = window.devicePixelRatio || 1;
      windows.requestActivation(Math.round((rect.left + rect.width / 2) * scale), Math.round((rect.top + rect.height / 2) * scale));
    }, 150);
  }

  async function playEpisode(index, offset = 0, shouldPlay = true) {
    if (!episodes[index - 1]) return;
    if (!sessionAvailable) {reopen(index, offset); return;}
    if (currentIndex && currentIndex !== index) reportProgress({force: true});
    stopStream();
    currentIndex = index;
    window.JukuPlaybackDanmaku?.setEpisode(sessionID, index, episodes[index - 1].danmaku);
    lastPosition = offset;
    knownDuration = 0;
    updateEpisodeControls();
    errorText.textContent = '';
    setStatus(offset > 0 ? '正在跳转并缓冲…' : '正在解析播放地址…', true);
    const version = streamVersion;
    const currentSession = sessionID;
    const controller = new AbortController();
    streamController = controller;
    const signal = controller.signal;
    const source = new MediaSource();
    let reader;
    try {
      if (collectionMode && preparedIndex !== index) {
        setStatus('正在检查本地分集并准备下载…', true);
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
      if (duration > 0 && Number.isFinite(duration)) {source.duration = duration; knownDuration = duration;}
      setStatus(response.headers.get('X-Playback-Prefetched') === '1' ? '正在读取预缓存…' : '正在缓冲…', true);
      reader = response.body.getReader();
      let initialized = false;
      while (!signal.aborted) {
        while (!signal.aborted && bufferedAhead() > bufferTargetSeconds(video.paused && initialized)) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (signal.aborted) throw abortError();
        const chunk = await reader.read();
        if (chunk.done) break;
        await trimBuffer(buffer, signal);
        await waitForEvent(buffer, 'updateend', signal, () => buffer.appendBuffer(chunk.value));
        if (!initialized && buffer.buffered.length) {
          initialized = true;
          retryCount = 0;
          video.currentTime = Math.min(buffer.buffered.end(0) - 0.001, Math.max(offset, buffer.buffered.start(0) + 0.03));
          video.playbackRate = Number(rateSelect.value) || 1;
          loading = false;
          hideOverlay();
          statusText.textContent = shouldPlay ? '正在播放' : '已暂停';
          if (shouldPlay) video.play().catch(error => {
            if (version !== streamVersion || signal.aborted) return;
            if (error.name === 'NotAllowedError') {statusText.textContent = '已就绪，点击画面开始播放'; showOverlay('点击画面开始播放'); requestHostClick();}
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
      if (version === streamVersion && !signal.aborted) failStream(error, index, shouldPlay);
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
    showOverlay('正在跳转…');
    seekTimer = setTimeout(() => playEpisode(currentIndex, target, !video.paused), SEEK_DEBOUNCE_MS);
  });
  video.addEventListener('seeked', () => {if (!loading) hideOverlay();});
  video.addEventListener('timeupdate', () => {
    if (!loading && Number.isFinite(video.currentTime)) {lastPosition = video.currentTime; if (!video.paused) reportProgress();}
    maybePrefetchNext();
  });
  video.addEventListener('playing', () => {if (!loading && !errorText.textContent) statusText.textContent = '正在播放'; hideOverlay(); maybePrefetchNext();});
  video.addEventListener('waiting', () => {if (!loading && !errorText.textContent) {statusText.textContent = '正在缓冲…'; showOverlay('正在缓冲…');}});
  video.addEventListener('canplay', () => {if (!loading) hideOverlay();});
  video.addEventListener('pause', () => {if (!loading && !video.ended && !errorText.textContent) statusText.textContent = '已暂停'; if (!loading) reportProgress({force: true});});
  video.addEventListener('error', () => {
    if (!video.error || !video.hasAttribute('src') || !isOpen) return;
    if (streamController) streamController.abort();
    failStream(new Error('浏览器播放失败，请检查网络或重试（错误 ' + video.error.code + '）'), currentIndex, true);
  });
  video.addEventListener('ended', () => {
    if (loading || !isOpen || errorText.textContent) return;
    reportProgress({force: true, finished: true});
    if (autoNextToggle.checked && currentIndex < episodes.length) playEpisode(currentIndex + 1);
    else statusText.textContent = currentIndex >= episodes.length ? '全部播放完毕' : '本集播放完毕';
  });
  // 点击画面：播放 / 暂停；选集面板开着时先收起面板；双击：全屏
  video.addEventListener('click', () => {
    if (episodesOpen) {setEpisodesPanel(false); return;}
    if (loading) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  });
  video.addEventListener('dblclick', () => window.JukuNativeFullscreen?.());
  node('previousEpisodeBtn').addEventListener('click', () => playEpisode(currentIndex - 1, episodeStartOffset(currentIndex - 1)));
  node('nextEpisodeBtn').addEventListener('click', () => playEpisode(currentIndex + 1, episodeStartOffset(currentIndex + 1)));
  node('retryPlaybackBtn').addEventListener('click', () => {
    preparedIndex = 0;
    retryCount = 0;
    if (episodes.length && sessionAvailable) playEpisode(currentIndex || 1, lastPosition);
    else reopen(currentIndex || 1, lastPosition);
  });
  rateSelect.addEventListener('change', () => {video.playbackRate = Number(rateSelect.value) || 1; store.set('juku.playback.rate', rateSelect.value); syncStageControls();});
  // 按 < / > 逐档降速、加速，档位与下拉框一致
  function stepRate(delta) {
    const options = Array.from(rateSelect.options);
    const index = Math.max(0, options.findIndex(option => option.value === rateSelect.value));
    const next = options[Math.min(options.length - 1, Math.max(0, index + delta))];
    if (!next || next.value === rateSelect.value) {toast('倍速 ' + rateSelect.value + ' 倍', 1200); return;}
    rateSelect.value = next.value;
    rateSelect.dispatchEvent(new Event('change'));
    toast('倍速 ' + next.value + ' 倍', 1200);
  }
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
    store.set('juku.playback.quality', value);
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

  // 网页全屏：铺满整个窗口，区别于占满显示器的原生全屏。
  function setWebFullscreen(on) {
    if (!on && windowMini) return;
    if (on && floating) setFloat(false);
    panel.classList.toggle('web-fullscreen', on);
    if (on) panel.classList.remove('pure-mode');
    applyStageRatio();
    syncStageControls();
    stage.focus({preventScroll: true});
  }
  node('webFullscreenBtn').addEventListener('click', () => setWebFullscreen(true));

  // 纯净模式：只切换 CSS class，画面尺寸由 --stage-cap 自动变化。
  function setPureMode(on) {
    if (on && floating) setFloat(false);
    panel.classList.toggle('pure-mode', on);
    if (on) panel.classList.remove('web-fullscreen');
    applyStageRatio();
    syncStageControls();
    stage.focus({preventScroll: true});
  }
  node('pureModeBtn').addEventListener('click', () => setPureMode(true));

  // 关闭播放器：上报最终进度、释放会话，再交给外壳切回原视图。
  function close(silent) {
    if (!isOpen) return;
    // 独立窗口关闭后页面随即卸载，进度用 beacon 发送才能送达
    reportProgress({force: true, beacon: Boolean(silent) || windowMode});
    const wasFloating = floating;
    isOpen = false;
    dispose();
    if (wasFloating) exitFloatVisuals();
    dramaID = '';
    collectionTaskID = '';
    episodes = [];
    episodeButtons = [];
    currentIndex = 0;
    stageEpisodeButtons = [];
    if (episodesOpen) setEpisodesPanel(false);
    syncTitle();
    // 小窗关闭时停留在当前页面，只把播放视图收起
    if (wasFloating) window.appShell?.refreshViews?.();
    else if (!silent) window.appShell?.leavePlayer();
  }
  // 弹出到独立窗口：带着当前集数和进度另开一个窗口继续播，页面里的播放随即关闭并释放会话。
  // mini 为真时开成紧凑小窗，画面铺满窗口。
  function popOut(mini) {
    if (!windows || windowMode || !isOpen || (!dramaID && !collectionTaskID)) return;
    const target = {mini: Boolean(mini), title: dramaName, dramaId: dramaID, index: currentIndex || 0, offset: !loading && currentIndex ? lastPosition : 0};
    if (collectionMode) target.taskId = episodes[currentIndex - 1]?.taskId || collectionTaskID;
    close(false);
    windows.openPlayer(target);
  }
  node('popWindowBtn').addEventListener('click', () => popOut(false));
  // 画面内的弹出图标：小窗模式下弹成独立小窗，其余弹成普通播放窗口
  node('icoPopBtn').addEventListener('click', () => popOut(floating));

  // 「显示方式」折叠菜单：点任一项后收起，点菜单外也收起。
  // 与下载页 batchMenu 用的是同一套交互，保持一致。
  const viewModeMenu = node('viewModeMenu');
  viewModeMenu.addEventListener('click', event => {
    if (event.target.closest('button')) viewModeMenu.open = false;
  });
  document.addEventListener('click', event => {
    if (viewModeMenu.open && !viewModeMenu.contains(event.target)) viewModeMenu.open = false;
  });
  // Esc 分层退出：先退原生全屏 / 网页全屏 / 纯净模式 / 小窗，最后才返回
  function escape() {
    if (episodesOpen) {setEpisodesPanel(false); return;}
    if (document.fullscreenElement || document.webkitFullscreenElement) {window.JukuNativeFullscreen?.(); return;}
    if (floating) {setFloat(false); return;}
    if (panel.classList.contains('web-fullscreen') && !windowMini) {setWebFullscreen(false); return;}
    if (panel.classList.contains('pure-mode')) {setPureMode(false); return;}
    close(false);
  }
  node('closePlayerBtn').addEventListener('click', () => close(false));
  window.addEventListener('pagehide', () => {reportProgress({force: true, beacon: true}); dispose();});
  document.addEventListener('visibilitychange', () => {if (document.hidden && isOpen) reportProgress({force: true, beacon: true});});

  // ===== 键盘快捷键（播放视图打开且焦点不在输入控件时生效） =====
  function seekBy(delta) {
    if (loading || !currentIndex) return;
    const duration = currentDuration();
    let target = Math.max(0, (video.currentTime || 0) + delta);
    if (duration > 0) target = Math.min(target, Math.max(0, duration - 0.5));
    video.currentTime = target;
    toast((delta > 0 ? '快进 ' : '快退 ') + Math.abs(delta) + ' 秒 · ' + (window.JukuHistory?.formatClock(target) || Math.round(target) + 's'), 1200);
  }
  function adjustVolume(delta) {
    video.muted = false;
    video.volume = Math.max(0, Math.min(1, Math.round((video.volume + delta) * 20) / 20));
    toast('音量 ' + Math.round(video.volume * 100) + '%', 1200);
  }
  document.addEventListener('keydown', event => {
    if (!isOpen) return;
    // 小窗浮在其他页面上时，只有小窗自身有焦点才响应快捷键，避免影响页面操作
    if (floating && document.body.dataset.view !== 'player' && !stage.contains(document.activeElement)) return;
    const target = event.target;
    const tag = target && target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (target && target.isContentEditable)) {
      if (event.key === 'Escape') {target.blur(); event.preventDefault();}
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    switch (event.key) {
      case ' ': case 'k': case 'K':
        event.preventDefault();
        if (loading) return;
        if (video.paused) video.play().catch(() => {}); else video.pause();
        break;
      case 'ArrowLeft': event.preventDefault(); seekBy(-SEEK_STEP_SECONDS * (event.shiftKey ? 6 : 1)); break;
      case 'ArrowRight': event.preventDefault(); seekBy(SEEK_STEP_SECONDS * (event.shiftKey ? 6 : 1)); break;
      case 'ArrowUp': event.preventDefault(); adjustVolume(0.05); break;
      case 'ArrowDown': event.preventDefault(); adjustVolume(-0.05); break;
      case 'm': case 'M': event.preventDefault(); video.muted = !video.muted; toast(video.muted ? '已静音' : '取消静音', 1200); break;
      case 'n': case 'N': case ']': event.preventDefault(); if (!node('nextEpisodeBtn').disabled) node('nextEpisodeBtn').click(); break;
      case 'p': case 'P': case '[': event.preventDefault(); if (!node('previousEpisodeBtn').disabled) node('previousEpisodeBtn').click(); break;
      case 'f': case 'F': event.preventDefault(); window.JukuNativeFullscreen?.(); break;
      case 'w': case 'W': event.preventDefault(); setWebFullscreen(!panel.classList.contains('web-fullscreen')); break;
      case 'i': case 'I': event.preventDefault(); setFloat(!floating); break;
      case 'e': case 'E': event.preventDefault(); setEpisodesPanel(!episodesOpen); break;
      case '>': case '.': event.preventDefault(); stepRate(1); break;
      case '<': case ',': event.preventDefault(); stepRate(-1); break;
      case 'Escape': event.preventDefault(); escape(); break;
      default: return;
    }
    wakeControls();
  });

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
    mirrorOptions(rateSelect, stageRate);
    mirrorOptions(qualitySelect, stageQuality);
    node('icoPrevBtn').disabled = node('previousEpisodeBtn').disabled;
    node('icoNextBtn').disabled = node('nextEpisodeBtn').disabled;
    node('icoReloadBtn').disabled = node('retryPlaybackBtn').disabled;
    icoPip.hidden = node('pipBtn').hidden;
    useIcon(icoPlay, video.paused ? 'icoPlay' : 'icoPause');
    useIcon(icoExpand, panel.classList.contains('web-fullscreen') ? 'icoCollapse' : 'icoExpand');
    icoExpand.title = panel.classList.contains('web-fullscreen') ? '退出网页全屏（W）' : '网页全屏（W）';
    // 纯净模式会隐藏外部工具栏，退出入口只能留在图标条上
    const pure = panel.classList.contains('pure-mode');
    useIcon(icoPure, pure ? 'icoPureOff' : 'icoPure');
    icoPure.title = pure ? '退出纯净模式' : '纯净模式';
    // 原生全屏：可见性跟随外部按钮（由 player-danmaku.js 按浏览器支持情况决定）
    icoFull.hidden = node('playerFullscreenBtn').hidden;
    const native = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
    useIcon(icoFull, native ? 'icoFullExit' : 'icoFull');
    icoFull.title = native ? '退出全屏（F）' : '全屏（F）';
  }

  node('icoPrevBtn').addEventListener('click', () => node('previousEpisodeBtn').click());
  node('icoNextBtn').addEventListener('click', () => node('nextEpisodeBtn').click());
  node('icoReloadBtn').addEventListener('click', () => node('retryPlaybackBtn').click());
  icoPip.addEventListener('click', () => node('pipBtn').click());
  icoPlay.addEventListener('click', () => {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  });
  node('icoCloseBtn').addEventListener('click', () => escape());
  // 同一个按钮兼作进入与退出，图标随状态切换
  icoExpand.addEventListener('click', () => setWebFullscreen(!panel.classList.contains('web-fullscreen')));
  icoPure.addEventListener('click', () => setPureMode(!panel.classList.contains('pure-mode')));
  // 原生全屏逻辑由 player-danmaku.js 持有（它同时管弹幕层的重排），这里只借用
  icoFull.addEventListener('click', () => window.JukuNativeFullscreen?.());
  for (const event of ['fullscreenchange', 'webkitfullscreenchange']) {
    document.addEventListener(event, syncStageControls);
  }

  // ===== 置顶：只有桌面版独立窗口能做到；记住选择，下次打开同类窗口沿用 =====
  const pinButton = node('pinWindowBtn');
  const icoPin = node('icoPinBtn');
  const pinKey = 'juku.window.pinned.' + (windows?.mode || 'player');
  let pinned = false;
  function syncPin() {
    const available = Boolean(windows && windows.canPin());
    pinButton.hidden = !available;
    icoPin.hidden = !available;
    pinButton.textContent = pinned ? '取消置顶' : '置顶';
    useIcon(icoPin, pinned ? 'icoPinOff' : 'icoPin');
    icoPin.title = pinned ? '取消置顶' : '窗口置顶';
  }
  function setPinned(on) {
    pinned = Boolean(on);
    windows?.setPinned(pinned);
    store.set(pinKey, pinned);
    syncPin();
    toast(pinned ? '窗口已置顶' : '已取消置顶', 1200);
  }
  pinButton.addEventListener('click', () => setPinned(!pinned));
  icoPin.addEventListener('click', () => setPinned(!pinned));
  syncPin();
  // 桌面运行时是异步补加载的，就绪后再决定显示置顶按钮，并恢复上次的置顶选择
  windows?.runtimeReady?.then(ok => {
    if (!ok || !windows.canPin()) return;
    if (store.get(pinKey) === 'true') {pinned = true; windows.setPinned(true);}
    syncPin();
  });

  // ===== 画面右键菜单：常用操作集中在一处，桌面版本来没有系统菜单 =====
  window.JukuMenu?.attach(stage, () => {
    if (!isOpen) return [];
    const pure = panel.classList.contains('pure-mode');
    const web = panel.classList.contains('web-fullscreen');
    const nativeFull = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
    return [
      {label: video.paused ? '播放' : '暂停', hint: '空格', disabled: loading, action: () => icoPlay.click()},
      {label: '上一集', hint: 'P', disabled: node('previousEpisodeBtn').disabled, action: () => node('previousEpisodeBtn').click()},
      {label: '下一集', hint: 'N', disabled: node('nextEpisodeBtn').disabled, action: () => node('nextEpisodeBtn').click()},
      {label: episodesOpen ? '收起选集' : '选集', hint: 'E', action: () => setEpisodesPanel(!episodesOpen)},
      {separator: true},
      windows && !windowMode ? {label: '弹出到独立窗口', action: () => popOut(false)} : null,
      windows && !windowMode ? {label: '弹出为独立小窗', action: () => popOut(true)} : null,
      !windowMode ? {label: floating ? '退出小窗模式' : '小窗模式', hint: 'I', action: () => setFloat(!floating)} : null,
      windows && windows.canPin() ? {label: pinned ? '取消置顶' : '窗口置顶', action: () => setPinned(!pinned)} : null,
      pipSupported ? {label: document.pictureInPictureElement ? '退出画中画' : '画中画', action: () => pipButton.click()} : null,
      {separator: true},
      {label: pure ? '退出纯净模式' : '纯净模式', action: () => setPureMode(!pure)},
      {label: web ? '退出网页全屏' : '网页全屏', hint: 'W', action: () => setWebFullscreen(!web)},
      !node('playerFullscreenBtn').hidden ? {label: nativeFull ? '退出全屏' : '全屏', hint: 'F', action: () => window.JukuNativeFullscreen?.()} : null,
      {separator: true},
      {label: windowMode ? '关闭窗口' : '返回', hint: 'Esc', action: () => close(false)}
    ];
  }, () => dramaName);
  // 下拉改动同步回原控件并触发 change，走原有的重新取流逻辑
  stageRate.addEventListener('change', () => {
    rateSelect.value = stageRate.value;
    rateSelect.dispatchEvent(new Event('change'));
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
      if (!stageControls.matches(':hover') && !stageControls.matches(':focus-within')) {
        stage.classList.add('stage-idle');
      }
    }, 2600);
  }
  for (const event of ['pointermove', 'pointerdown', 'keydown']) {
    stage.addEventListener(event, wakeControls);
  }
  stage.addEventListener('pointerleave', () => {
    clearTimeout(idleTimer);
    if (!video.paused && !stageControls.matches(':focus-within')) stage.classList.add('stage-idle');
  });
  video.addEventListener('pause', () => {wakeControls(); syncStageControls();});
  video.addEventListener('play', () => {wakeControls(); syncStageControls();});
  video.addEventListener('playing', syncStageControls);
  syncStageControls();
  wakeControls();

  // ===== 底部控制条：进度、时间、音量 =====
  // <video> 不再使用原生 controls，进度与音量由这里提供，跳转仍走既有的 seeking 逻辑。
  const seekBar = node('seekBar');
  const seekPlayed = node('seekPlayed');
  const seekBuffered = node('seekBuffered');
  const seekHandle = node('seekHandle');
  const seekTip = node('seekTip');
  const timeText = node('timeText');
  const btmPlay = node('btmPlayBtn');
  const muteBtn = node('muteBtn');
  const volumeSlider = node('volumeSlider');
  const clock = seconds => window.JukuHistory ? window.JukuHistory.formatClock(seconds) : String(Math.round(seconds || 0));
  let seekDragging = false;
  function seekRatio(event) {
    const rect = seekBar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
  }
  function renderTimeline(previewRatio) {
    const duration = currentDuration();
    const time = seekDragging && previewRatio !== undefined ? previewRatio * duration : (Number.isFinite(video.currentTime) ? video.currentTime : 0);
    const ratio = duration > 0 ? Math.max(0, Math.min(1, time / duration)) : 0;
    seekPlayed.style.width = (ratio * 100) + '%';
    seekHandle.style.left = (ratio * 100) + '%';
    seekBar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    let bufferedEnd = 0;
    for (let index = 0; index < video.buffered.length; index++) {
      if (video.buffered.start(index) <= video.currentTime + 0.5 && video.buffered.end(index) >= video.currentTime - 0.5) {bufferedEnd = video.buffered.end(index); break;}
      bufferedEnd = Math.max(bufferedEnd, video.buffered.end(index));
    }
    seekBuffered.style.width = (duration > 0 ? Math.min(100, bufferedEnd / duration * 100) : 0) + '%';
    timeText.textContent = clock(time) + ' / ' + clock(duration);
  }
  function seekToRatio(ratio) {
    const duration = currentDuration();
    if (!(duration > 0) || loading || !currentIndex) return;
    video.currentTime = Math.min(Math.max(0, ratio * duration), Math.max(0, duration - 0.5));
  }
  function showSeekTip(event) {
    const duration = currentDuration();
    if (!(duration > 0)) {seekTip.hidden = true; return;}
    const ratio = seekRatio(event);
    seekTip.hidden = false;
    seekTip.style.left = (ratio * 100) + '%';
    seekTip.textContent = clock(ratio * duration);
  }
  seekBar.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    seekDragging = true;
    seekBar.classList.add('dragging');
    try {seekBar.setPointerCapture(event.pointerId);} catch (_) {}
    renderTimeline(seekRatio(event));
    showSeekTip(event);
    event.preventDefault();
  });
  seekBar.addEventListener('pointermove', event => {showSeekTip(event); if (seekDragging) renderTimeline(seekRatio(event));});
  seekBar.addEventListener('pointerup', event => {
    if (!seekDragging) return;
    seekDragging = false;
    seekBar.classList.remove('dragging');
    seekToRatio(seekRatio(event));
    renderTimeline();
    wakeControls();
  });
  seekBar.addEventListener('pointercancel', () => {seekDragging = false; seekBar.classList.remove('dragging'); renderTimeline();});
  seekBar.addEventListener('pointerleave', () => {if (!seekDragging) seekTip.hidden = true;});
  function renderVolume() {
    volumeSlider.value = String(video.muted ? 0 : video.volume);
    useIcon(muteBtn, video.muted || video.volume === 0 ? 'icoMute' : 'icoVolume');
    muteBtn.title = video.muted ? '取消静音（M）' : '静音（M）';
    useIcon(btmPlay, video.paused ? 'icoPlay' : 'icoPause');
  }
  volumeSlider.addEventListener('input', () => {video.muted = false; video.volume = Number(volumeSlider.value);});
  muteBtn.addEventListener('click', () => {video.muted = !video.muted;});
  btmPlay.addEventListener('click', () => icoPlay.click());
  for (const eventName of ['timeupdate', 'progress', 'durationchange', 'loadedmetadata', 'seeked', 'emptied']) video.addEventListener(eventName, () => renderTimeline());
  for (const eventName of ['volumechange', 'play', 'pause', 'playing']) video.addEventListener(eventName, renderVolume);
  renderVolume();
  renderTimeline();

  // ===== 小窗模式：剧场变成悬浮窗，按画面比例等比缩放、可拖动，尺寸与位置记忆 =====
  const theater = stage.parentElement;
  const floatResize = node('floatResize');
  const icoFloat = node('icoFloatBtn');
  const floatModeBtn = node('floatModeBtn');
  const floatPref = (() => {
    try {
      const parsed = JSON.parse(store.get('juku.player.float') || '{}');
      return {on: Boolean(parsed.on), x: Number(parsed.x), y: Number(parsed.y), w: Object.assign({}, parsed.w)};
    } catch (_) {return {on: false, x: NaN, y: NaN, w: {}};}
  })();
  function saveFloatPref() {store.set('juku.player.float', JSON.stringify(floatPref));}
  function videoRatio() {return video.videoWidth && video.videoHeight ? video.videoHeight / video.videoWidth : 9 / 16;}
  function orientationKey() {return videoRatio() > 1 ? 'portrait' : 'landscape';}
  function clampFloatPosition() {
    floatRect.x = Math.round(Math.max(FLOAT_MARGIN, Math.min(floatRect.x, window.innerWidth - floatRect.w - FLOAT_MARGIN)));
    floatRect.y = Math.round(Math.max(FLOAT_MARGIN, Math.min(floatRect.y, window.innerHeight - floatRect.h - FLOAT_MARGIN)));
  }
  function renderFloat() {
    if (!floating) return;
    theater.style.left = floatRect.x + 'px';
    theater.style.top = floatRect.y + 'px';
    theater.style.width = floatRect.w + 'px';
    theater.style.height = floatRect.h + 'px';
  }
  // 以宽度为准按画面比例算高度；超出视口时按高度回推宽度，位置为空则放到右下角
  function applyFloatSize(width) {
    const ratio = videoRatio();
    let w = Math.max(FLOAT_MIN_WIDTH, Math.min(width || 0, window.innerWidth - FLOAT_MARGIN * 2));
    let h = w * ratio;
    const maxH = window.innerHeight - FLOAT_MARGIN * 2;
    if (h > maxH) {h = maxH; w = Math.max(FLOAT_MIN_WIDTH, h / ratio);}
    floatRect.w = Math.round(w);
    floatRect.h = Math.round(h);
    if (!Number.isFinite(floatRect.x) || !Number.isFinite(floatRect.y)) {
      floatRect.x = window.innerWidth - floatRect.w - 24;
      floatRect.y = window.innerHeight - floatRect.h - 24;
    }
    clampFloatPosition();
    renderFloat();
  }
  function rememberFloat() {
    floatPref.x = floatRect.x;
    floatPref.y = floatRect.y;
    floatPref.w[orientationKey()] = floatRect.w;
    saveFloatPref();
  }
  // 横竖屏分别记忆宽度：竖屏短剧默认窄一些
  function preferredFloatWidth() {return floatPref.w[orientationKey()] || (orientationKey() === 'portrait' ? 300 : 480);}
  function syncFloatControls() {
    useIcon(icoFloat, floating ? 'icoFloatOff' : 'icoFloat');
    icoFloat.title = floating ? '还原到页面（I）' : '小窗模式（I）';
    floatModeBtn.textContent = floating ? '退出小窗' : '小窗模式';
  }
  function setFloat(on) {
    // 独立窗口本身就是一个窗口，不再套一层页面内小窗
    if (on === floating || (on && windowMode)) return;
    if (on) {
      panel.classList.remove('pure-mode', 'web-fullscreen');
      if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
      floating = true;
      panel.classList.add('float-mode');
      floatRect.x = floatPref.x;
      floatRect.y = floatPref.y;
      applyFloatSize(preferredFloatWidth());
      floatPref.on = true;
      saveFloatPref();
      // 悬浮起来后回到进入播放前的页面，可以边看边逛
      if (window.appShell?.currentView?.() === 'player') window.appShell.leavePlayer();
      else window.appShell?.refreshViews?.();
      toast('小窗模式：拖动顶栏移动，拖右下角等比缩放，按 I 或 Esc 还原', 3500);
    } else {
      exitFloatVisuals();
      floatPref.on = false;
      saveFloatPref();
      if (isOpen) window.appShell?.showView('player');
    }
    syncStageControls();
    stage.focus({preventScroll: true});
  }
  // 关闭播放时只收起悬浮窗外观，不改变用户记住的模式选择
  function exitFloatVisuals() {
    floating = false;
    panel.classList.remove('float-mode');
    for (const key of ['left', 'top', 'width', 'height']) theater.style.removeProperty(key);
    syncFloatControls();
  }
  icoFloat.addEventListener('click', () => setFloat(!floating));
  floatModeBtn.addEventListener('click', () => setFloat(!floating));
  // 拖动：按住顶部图标条的空白处移动
  let dragState = null;
  stageControls.addEventListener('pointerdown', event => {
    if (!floating || event.button !== 0 || event.target.closest('button, select, label')) return;
    dragState = {x: event.clientX, y: event.clientY, left: floatRect.x, top: floatRect.y};
    try {stageControls.setPointerCapture(event.pointerId);} catch (_) {}
    event.preventDefault();
  });
  stageControls.addEventListener('pointermove', event => {
    if (!dragState) return;
    floatRect.x = dragState.left + event.clientX - dragState.x;
    floatRect.y = dragState.top + event.clientY - dragState.y;
    clampFloatPosition();
    renderFloat();
  });
  for (const eventName of ['pointerup', 'pointercancel']) stageControls.addEventListener(eventName, () => {if (dragState) {dragState = null; rememberFloat();}});
  // 缩放：右下角手柄，横向或纵向拖动量取较大者换算成宽度，保持画面比例
  let resizeState = null;
  floatResize.addEventListener('pointerdown', event => {
    if (!floating || event.button !== 0) return;
    resizeState = {x: event.clientX, y: event.clientY, w: floatRect.w, h: floatRect.h, left: floatRect.x, top: floatRect.y};
    try {floatResize.setPointerCapture(event.pointerId);} catch (_) {}
    event.preventDefault();
    event.stopPropagation();
  });
  floatResize.addEventListener('pointermove', event => {
    if (!resizeState) return;
    const width = Math.max(resizeState.w + event.clientX - resizeState.x, (resizeState.h + event.clientY - resizeState.y) / videoRatio());
    floatRect.x = resizeState.left;
    floatRect.y = resizeState.top;
    applyFloatSize(width);
  });
  for (const eventName of ['pointerup', 'pointercancel']) floatResize.addEventListener(eventName, () => {if (resizeState) {resizeState = null; rememberFloat();}});
  window.addEventListener('resize', () => {if (floating) applyFloatSize(floatRect.w);});
  // 换集后画面比例可能变化（横竖屏），按记住的宽度重新算高度
  video.addEventListener('loadedmetadata', () => {if (floating) applyFloatSize(preferredFloatWidth());});
  syncFloatControls();

  // 桌面版独立窗口点标题栏关闭时，先上报进度、释放会话，再让进程退出
  if (windowMode && windows) windows.onCloseRequest(() => {close(true); windows.closeSelf();});

  window.dramaPlayer = {open, openCollection, updateDependency, close, isOpen: () => isOpen, isFloating: () => floating, setFloat, setWebFullscreen, popOut};
})();
