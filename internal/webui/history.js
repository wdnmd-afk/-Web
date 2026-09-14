/* 观看历史客户端：与 /api/ui/history 同步，供历史视图、剧库角标和播放器续播使用。
   进度由播放器上报；这里只负责缓存、渲染和查询，不持有播放逻辑。 */
(() => {
  const node = id => document.getElementById(id);
  let entries = [];
  let byID = new Map();
  let loaded = false;
  const listeners = new Set();
  const list = node('historyList');
  const countText = node('historyCount');
  const search = node('historySearch');
  const clearButton = node('clearHistoryBtn');
  // 5 秒以内、或距结尾不足 8 秒的位置不值得续播，直接从头（或下一集）开始。
  const RESUME_MIN_SECONDS = 5;
  const RESUME_TAIL_SECONDS = 8;

  function index(next) {
    entries = Array.isArray(next) ? next : [];
    byID = new Map(entries.map(entry => [entry.dramaId, entry]));
    notify();
  }

  function notify() {
    for (const listener of listeners) {
      try {listener(entries);} catch (_) {}
    }
    render();
  }

  async function request(path, body) {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {'Accept': 'application/json', 'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store'
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'HTTP ' + response.status);
    return result;
  }

  async function load() {
    try {
      const result = await request('/api/ui/history');
      loaded = true;
      index(result.data);
    } catch (error) {
      if (list) list.replaceChildren(element('div', 'empty', '历史读取失败：' + error.message));
    }
    return entries;
  }

  // 通知其他窗口重新读取历史：换集、看完、最终上报立即发；同一集的周期上报最多每 20 秒一次
  let lastNotifyAt = 0;
  let lastNotifyKey = '';
  function broadcast(payload, final) {
    const key = payload.dramaId + ':' + payload.index + ':' + (payload.finished ? 1 : 0);
    const now = Date.now();
    if (!final && key === lastNotifyKey && now - lastNotifyAt < 20000) return;
    lastNotifyAt = now;
    lastNotifyKey = key;
    window.JukuWindows?.notify('history', {dramaId: payload.dramaId});
  }

  // 上报一次进度。final 为真时用 sendBeacon，页面关闭前也能送达。
  function report(payload, final) {
    if (!payload || !payload.dramaId || !(payload.index > 0)) return Promise.resolve(null);
    const body = JSON.stringify(payload);
    // 先本地合并，界面立刻反映；服务端返回后再以其为准。别的窗口收到广播后重新读取。
    mergeLocal(payload);
    if (final && navigator.sendBeacon) {
      navigator.sendBeacon('/api/ui/history', new Blob([body], {type: 'application/json'}));
      broadcast(payload, true);
      return Promise.resolve(null);
    }
    return request('/api/ui/history', payload).then(result => {
      if (result && result.data) {
        byID.set(result.data.dramaId, result.data);
        entries = entries.filter(entry => entry.dramaId !== result.data.dramaId);
        entries.unshift(result.data);
        notify();
      }
      broadcast(payload, false);
      return result && result.data;
    }).catch(() => null);
  }

  function mergeLocal(payload) {
    const now = new Date().toISOString();
    let entry = byID.get(payload.dramaId);
    if (!entry) {
      entry = {dramaId: payload.dramaId, episodes: {}};
      byID.set(payload.dramaId, entry);
    }
    for (const key of ['title', 'cover', 'channel', 'mode', 'taskId']) if (payload[key]) entry[key] = payload[key];
    if (payload.episodeCount > 0) entry.episodeCount = payload.episodeCount;
    const finished = Boolean(payload.finished) || payload.duration > 0 && payload.position >= payload.duration * 0.97;
    const key = String(payload.index);
    entry.episodes = entry.episodes || {};
    const record = entry.episodes[key] || {index: payload.index};
    if (payload.episode) record.episode = payload.episode;
    record.position = payload.position || 0;
    if (payload.duration > 0) record.duration = payload.duration;
    record.finished = Boolean(record.finished) || finished;
    record.updatedAt = now;
    entry.episodes[key] = record;
    entry.lastIndex = payload.index;
    entry.lastEpisode = record.episode;
    entry.position = record.position;
    entry.duration = record.duration || 0;
    entry.finished = finished;
    entry.updatedAt = now;
    entries = entries.filter(item => item.dramaId !== entry.dramaId);
    entries.unshift(entry);
    notify();
  }

  async function remove(ids, all) {
    const result = await request('/api/ui/history/remove', all ? {all: true} : {ids});
    index(result.data);
    return result.removed || 0;
  }

  function get(dramaId) {
    return byID.get(dramaId) || null;
  }

  function episodeRecord(dramaId, index) {
    const entry = byID.get(dramaId);
    return entry && entry.episodes ? entry.episodes[String(index)] || null : null;
  }

  // 某一集应从哪里开始：看过一部分就接着看，看完或几乎没看就从头。
  function episodeOffset(dramaId, index) {
    const record = episodeRecord(dramaId, index);
    if (!record || record.finished) return 0;
    if (!(record.position > RESUME_MIN_SECONDS)) return 0;
    if (record.duration > 0 && record.duration - record.position < RESUME_TAIL_SECONDS) return 0;
    return record.position;
  }

  // 打开一部剧时的续播位置：上次那集没看完就接着看；看完了就跳到下一集。
  function resumeFor(dramaId, totalEpisodes) {
    const entry = byID.get(dramaId);
    if (!entry || !(entry.lastIndex > 0)) return null;
    const total = totalEpisodes || entry.episodeCount || 0;
    const record = episodeRecord(dramaId, entry.lastIndex);
    const finished = entry.finished || record && record.finished && entry.position >= (record.duration || 0) * 0.97;
    if (finished) {
      if (total && entry.lastIndex < total) return {index: entry.lastIndex + 1, offset: 0, reason: 'next'};
      return {index: entry.lastIndex, offset: 0, reason: 'replay'};
    }
    return {index: entry.lastIndex, offset: episodeOffset(dramaId, entry.lastIndex), reason: 'resume'};
  }

  function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function element(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = String(text);
    return item;
  }

  function formatClock(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    const hours = Math.floor(minutes / 60);
    const pad = value => String(value).padStart(2, '0');
    return hours ? hours + ':' + pad(minutes % 60) + ':' + pad(rest) : minutes + ':' + pad(rest);
  }

  function formatWhen(value) {
    const time = new Date(value);
    if (Number.isNaN(time.getTime())) return '';
    const diff = Date.now() - time.getTime();
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    const sameDay = time.toDateString() === new Date().toDateString();
    const clock = time.toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'});
    if (sameDay) return '今天 ' + clock;
    if (diff < 86400000 * 2) return '昨天 ' + clock;
    return time.toLocaleDateString('zh-CN', {month: 'numeric', day: 'numeric'}) + ' ' + clock;
  }

  function progressPercent(entry) {
    if (entry.finished) return 100;
    if (!(entry.duration > 0)) return 0;
    return Math.max(0, Math.min(100, Math.round(entry.position / entry.duration * 100)));
  }

  function episodeLabel(entry) {
    return '第 ' + (entry.lastEpisode || entry.lastIndex) + ' 集';
  }

  // 剧库卡片角标文字："看到第 3 集 12:34" / "第 3 集已看完"
  function badgeText(entry) {
    if (!entry || !(entry.lastIndex > 0)) return '';
    if (entry.finished) return episodeLabel(entry) + ' 已看完';
    return '看到' + episodeLabel(entry) + ' ' + formatClock(entry.position);
  }

  function watchedCount(entry) {
    if (!entry || !entry.episodes) return 0;
    return Object.values(entry.episodes).filter(record => record && record.finished).length;
  }

  function play(entry) {
    if (!window.dramaPlayer) return;
    if (entry.mode === 'collection' && entry.taskId) window.dramaPlayer.openCollection(entry.taskId, entry.title, entry.dramaId);
    else window.dramaPlayer.open(entry.dramaId, entry.title || '短剧');
  }

  function renderItem(entry) {
    const item = element('div', 'history-item');
    item.dataset.dramaId = entry.dramaId;
    const cover = element(entry.cover ? 'img' : 'div', 'history-cover');
    if (entry.cover) {
      cover.src = entry.cover;
      cover.alt = (entry.title || '') + ' 封面';
      cover.loading = 'lazy';
      cover.addEventListener('error', () => {cover.replaceWith(element('div', 'history-cover'));});
    }
    cover.addEventListener('click', () => play(entry));
    item.appendChild(cover);
    const main = element('div', 'history-main');
    const title = element('div', 'history-title', entry.title || entry.dramaId);
    title.addEventListener('click', () => play(entry));
    main.appendChild(title);
    const parts = [];
    parts.push(entry.finished ? episodeLabel(entry) + ' 已看完' : '看到' + episodeLabel(entry) + ' ' + formatClock(entry.position) + (entry.duration > 0 ? ' / ' + formatClock(entry.duration) : ''));
    if (entry.episodeCount > 0) parts.push('共 ' + entry.episodeCount + ' 集');
    const watched = watchedCount(entry);
    if (watched) parts.push('已看完 ' + watched + ' 集');
    if (entry.mode === 'collection') parts.push('下载合集');
    parts.push(formatWhen(entry.updatedAt));
    main.appendChild(element('div', 'small', parts.filter(Boolean).join(' · ')));
    const bar = element('div', 'history-progress');
    const fill = element('span');
    fill.style.width = progressPercent(entry) + '%';
    bar.appendChild(fill);
    main.appendChild(bar);
    item.appendChild(main);
    const actions = element('div', 'history-actions');
    const resume = element('button', '', entry.finished ? (entry.episodeCount && entry.lastIndex < entry.episodeCount ? '看下一集' : '再看一遍') : '继续观看');
    resume.addEventListener('click', () => play(entry));
    actions.appendChild(resume);
    const del = element('button', 'secondary', '删除');
    del.addEventListener('click', async () => {
      del.disabled = true;
      try {await remove([entry.dramaId], false);} catch (error) {del.disabled = false; window.appShell?.message(error.message, true);}
    });
    actions.appendChild(del);
    item.appendChild(actions);
    window.JukuMenu?.attach(item, () => [
      {label: resume.textContent, action: () => play(entry)},
      ...(window.JukuWindows?.menuItems(entry.mode === 'collection' && entry.taskId ? {taskId: entry.taskId, dramaId: entry.dramaId, title: entry.title} : {dramaId: entry.dramaId, title: entry.title}) || []),
      {separator: true},
      {label: '删除记录', danger: true, action: () => del.click()}
    ], entry.title || entry.dramaId);
    return item;
  }

  function render() {
    if (!list) return;
    const keyword = (search?.value || '').trim().toLowerCase();
    const visible = entries.filter(entry => !keyword || String(entry.title || '').toLowerCase().includes(keyword));
    if (countText) countText.textContent = entries.length ? visible.length + ' / ' + entries.length : '';
    if (clearButton) clearButton.disabled = !entries.length;
    list.replaceChildren();
    if (!visible.length) {
      list.appendChild(element('div', 'empty', loaded ? (entries.length ? '没有匹配的历史' : '还没有观看记录，去剧库点开一部剧吧') : '正在读取历史…'));
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const entry of visible) fragment.appendChild(renderItem(entry));
    list.appendChild(fragment);
  }

  search?.addEventListener('input', render);
  clearButton?.addEventListener('click', async () => {
    if (!entries.length || !confirm('清空全部观看历史？此操作不可撤销。')) return;
    clearButton.disabled = true;
    try {await remove([], true);} catch (error) {window.appShell?.message(error.message, true);}
    finally {clearButton.disabled = !entries.length;}
  });

  window.JukuHistory = {load, report, remove, get, entries: () => entries, episodeRecord, episodeOffset, resumeFor, onChange, badgeText, formatClock, progressPercent};
})();
