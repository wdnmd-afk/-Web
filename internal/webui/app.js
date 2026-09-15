/* 主界面脚本：导航与视图切换、剧库（点击即播放 + 批量下载）、下载合集二级页面、设置。
   播放器在 player.js，观看历史在 history.js，榜单在 rankings.js。 */
(() => {
  const dramas = [];
  let tasks = [];
  const selected = new Set();
  const selectedTasks = new Set();
  const openGroups = new Set();
  let visibleIDs = [];
  let visibleGroups = [];
  let mergeStates = {};
  let libraryRevision = 0;
  let libraryRequest = false;
  let libraryReload = false;
  let libraryTimer = null;
  let libraryBusyText = '';
  let libraryIsLoading = false;
  let libraryMetadataRemaining = {};
  let sortMessage = '';
  let onlineSearchMessage = '';
  let onlineSearchQuery = '';
  let onlineSearchIDs = new Set();
  let searchController = null;
  let searchSequence = 0;
  let taskRequest = false;
  let cardRender = 0;
  let config = {};
  let ffmpegStatus = '';
  let messageTimer = null;
  const $ = id => document.getElementById(id);
  const cards = $('cards');
  const groupsEl = $('groups');

  function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = String(text); return node; }
  function empty(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function button(text, action, disabled, className) { const node = element('button', className || 'secondary', text); node.disabled = Boolean(disabled); node.addEventListener('click', action); return node; }
  function setMessage(text, isError) { clearTimeout(messageTimer); $('messageText').textContent = text || ''; $('messageText').className = isError ? 'error toast' : 'toast'; if (text) messageTimer = setTimeout(() => {$('messageText').textContent = '';}, 8000); }
  async function api(path, options) { const init = options || {}; init.headers = Object.assign({'Accept': 'application/json'}, init.headers || {}); if (init.body) init.headers['Content-Type'] = 'application/json'; const response = await fetch(path, init); let data; try {data = await response.json();} catch (_) {throw new Error('服务器未返回有效 JSON，请确认已启动新版程序');} if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status); return data; }
  function post(path, body) { return api(path, {method: 'POST', body: JSON.stringify(body)}); }
  function valueText(value) { if (value === undefined || value === null) return ''; if (Array.isArray(value)) return value.length ? String(value.length) : ''; if (typeof value === 'object') { for (const key of ['url', 'src', 'path', 'cover', 'image', 'pic', 'name', 'title', 'count', 'total']) {const text = valueText(value[key]); if (text) return text;} return ''; } const text = String(value).trim(); return text === '0' ? '' : text; }
  function firstNonEmpty(...values) { for (const value of values) {const text = valueText(value); if (text) return text;} return ''; }
  function dramaTitle(drama) { return drama.title || drama.name || '短剧'; }
  function normalizeSource(value) {
    let source = String(value || '').trim().toLowerCase();
    if (/^https?:\/\//.test(source)) {try {source = new URL(source).hostname;} catch (_) {return '';}}
    source = source.replace(/^www\./, '').split(':')[0];
    const aliases = {hongguo: 'hongguo', 'hongguoduanju.com': 'hongguo'};
    return Object.prototype.hasOwnProperty.call(aliases, source) ? aliases[source] : '';
  }
  function sourceKey(drama) { return normalizeSource(drama.source || drama.id); }
  function sourceLabel(value) { const names = {hongguo: '红果'}; return names[value] || value; }
  function categoryName(dr) { return firstNonEmpty(dr.categoryName, dr.category_name, dr.typeName, dr.type_name, dr.sortName, dr.sort_name, dr.category, dr.categoryNameSnake, dr.channelName) || '未分类'; }
  function episodeCount(dr) { return firstNonEmpty(dr.totalEpisode, dr.total_episode, dr.chapterCount, dr.chapter_count, dr.episodeCount, dr.episode_count, dr.episodes, dr.total); }
  function coverURL(dr) { return firstNonEmpty(dr.cover, dr.coverUrl, dr.cover_url, dr.image, dr.imageUrl, dr.image_url, dr.img, dr.pic, dr.picture, dr.poster, dr.thumb, dr.thumbnail); }
  function tagsText(dr) { return Array.isArray(dr.tags) ? dr.tags.map(valueText).filter(Boolean) : []; }
  function dramaSearchText(dr) { return [dr.title, dr.name, dr.id, dr.desc, dr.intro, dr.remark, sourceLabel(sourceKey(dr)), categoryName(dr), tagsText(dr).join(' ')].join(' ').toLowerCase(); }
  function filteredDramas() { const keyword = $('searchInput').value.trim().toLowerCase(); const source = $('sourceSelect').value; const channel = $('channelSelect').value; return dramas.filter(dr => {if (sourceKey(dr) !== 'hongguo' || source && sourceKey(dr) !== source) return false; const cat = categoryName(dr); if (channel && cat !== channel) return false; return !keyword || dramaSearchText(dr).includes(keyword) || onlineSearchQuery === keyword && onlineSearchIDs.has(dr.id);}); }
  function rebuildOptions(select, values, allLabel, labelFor, reset) { const previous = reset ? '' : select.value; empty(select); const all = element('option', '', allLabel); all.value = ''; select.appendChild(all); values.forEach(value => {const option = element('option', '', labelFor(value)); option.value = value; select.appendChild(option);}); select.value = values.includes(previous) ? previous : ''; }
  function rebuildSources() { rebuildOptions($('sourceSelect'), ['hongguo'], '全部站源', () => '红果', false); }
  function rebuildChannels(reset) { const source = $('sourceSelect').value; const values = Array.from(new Set(dramas.filter(drama => sourceKey(drama) === 'hongguo' && (!source || sourceKey(drama) === source)).map(categoryName))).sort((left, right) => left.localeCompare(right, 'zh-Hans-CN')); rebuildOptions($('channelSelect'), values, '全部分类', value => value, reset); updateRefreshLabel(); }
  function updateLibraryButton() { const source = $('sourceSelect').value; const hongguo = !source || source === 'hongguo'; const refresh = $('refreshBtn'); refresh.textContent = libraryIsLoading ? '更新中…' : '更新剧库'; refresh.disabled = libraryRequest || libraryIsLoading; refresh.setAttribute('aria-label', '更新' + (source ? sourceLabel(source) : '全部站源') + '剧库'); refresh.title = '检查新内容' + (hongguo ? '并继续加载历史目录' : '') + '，后台分批补充缺失资料；优先当前筛选结果' + (libraryMetadataRemaining[source] ? '，待检查 ' + libraryMetadataRemaining[source] + ' 部' : ''); }
  function metadataPriorityIDs() { const pending = new Set(dramas.filter(drama => !drama.sortMetadata || drama.sortMetadata.version !== 1).map(drama => drama.id)); return visibleIDs.filter(id => pending.has(id)).slice(0, 40); }
  function updateRefreshLabel() { const source = $('sourceSelect').value; const hongguo = !source || source === 'hongguo'; updateLibraryButton(); $('onlineSearchBtn').hidden = !hongguo; $('searchInput').placeholder = hongguo ? '本地筛选，回车联网搜红果' : '搜索剧名、简介、标签'; }
  function placeholder(text) { return element('div', 'cover placeholder', text || '暂无封面'); }
  function dramaMetaText(drama) { return firstNonEmpty(drama.remark, episodeCount(drama) ? '共 ' + episodeCount(drama) + ' 集' : '') + (drama.onlineDate ? ' · ' + drama.onlineDate : ''); }
  // 卡片复用键只包含卡片真正渲染的字段：简介已不在卡片里显示，
  // 若继续参与比对，简介变动会白白让整张卡重建。标签取前 3 个，与渲染一致。
  function dramaCardKey(drama) { return JSON.stringify([dramaTitle(drama), sourceKey(drama), categoryName(drama), episodeCount(drama), coverURL(drama), drama.remark, tagsText(drama).slice(0, 3)]); }
  function dramaByID(id) { return dramas.find(drama => drama.id === id) || null; }

  // ===== 视图切换：剧库 / 榜单 / 历史 / 下载 / 播放 =====
  const views = {library: $('libraryView'), rankings: $('rankingsView'), history: $('historyView'), downloads: $('downloadsView'), player: $('playerView')};
  let currentView = 'library';
  let returnView = 'library';
  // 小窗模式下播放视图始终保留在页面上（只显示悬浮窗），切换其他页面不会关闭播放
  function applyViewVisibility() {
    const floating = Boolean(window.dramaPlayer?.isFloating?.());
    for (const [key, section] of Object.entries(views)) section.hidden = key !== currentView && !(key === 'player' && floating);
  }
  function showView(name, options = {}) {
    if (!views[name]) name = 'library';
    const floating = Boolean(window.dramaPlayer?.isFloating?.());
    if (name === 'player' && currentView !== 'player') returnView = currentView;
    if (currentView === 'player' && name !== 'player' && !options.fromPlayer && !floating) window.dramaPlayer?.close(true);
    // 榜单页只在可见时保持在线请求：离开时中止在途请求并回写剧库改动，进入时重新取榜单
    if (currentView === 'rankings' && name !== 'rankings') window.JukuRankings?.deactivate();
    currentView = name;
    applyViewVisibility();
    if (name === 'rankings') window.JukuRankings?.activate();
    document.querySelectorAll('.nav button[data-view]').forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.view === name)));
    document.body.dataset.view = name;
    const hash = name === 'library' ? '' : '#' + name;
    if ((location.hash || '') !== hash && name !== 'player') history.replaceState(null, '', location.pathname + location.search + hash);
    if (name === 'history') window.JukuHistory?.load();
  }
  // 独立播放窗口里“返回”就是关掉这个窗口
  function leavePlayer() { if (window.JukuWindows?.isWindow) {window.JukuWindows.closeSelf(); return;} showView(returnView === 'player' ? 'library' : returnView, {fromPlayer: true}); }
  document.querySelectorAll('.nav button[data-view]').forEach(tab => tab.addEventListener('click', () => showView(tab.dataset.view)));
  window.addEventListener('hashchange', () => { const name = location.hash.replace('#', ''); if (views[name] && name !== 'player' && name !== currentView) showView(name); });

  // ===== 播放视图侧栏：简介与“加入下载” =====
  let playerDramaID = '';
  let playerInfoArgs = null;
  function renderPlayerInfo(dramaID, title, mode) {
    playerDramaID = dramaID || '';
    playerInfoArgs = {dramaID, title, mode};
    const info = $('playerInfo');
    const download = $('playerDownloadBtn');
    const drama = dramaByID(dramaID);
    empty(info);
    download.hidden = !dramaID || mode === 'collection';
    if (!drama) { info.hidden = !title; if (title) info.appendChild(element('div', 'player-info-title', title)); return; }
    info.hidden = false;
    const head = element('div', 'player-info-head');
    const cover = coverURL(drama);
    if (cover) { const image = element('img', 'player-info-cover'); image.src = cover; image.alt = ''; image.loading = 'lazy'; image.addEventListener('error', () => image.remove()); head.appendChild(image); }
    const text = element('div', 'player-info-text');
    text.appendChild(element('div', 'player-info-title', dramaTitle(drama)));
    text.appendChild(element('div', 'small', [categoryName(drama), dramaMetaText(drama), drama.heat ? '热度 ' + drama.heat : '', drama.views ? '播放 ' + drama.views : ''].filter(Boolean).join(' · ')));
    head.appendChild(text);
    info.appendChild(head);
    const description = firstNonEmpty(drama.desc, drama.intro);
    if (description) info.appendChild(element('div', 'small player-info-desc', description));
    const tags = tagsText(drama);
    if (tags.length) { const wrap = element('div', 'tags'); tags.slice(0, 8).forEach(tag => wrap.appendChild(element('span', 'tag', tag))); info.appendChild(wrap); }
  }
  $('playerDownloadBtn').addEventListener('click', () => { if (playerDramaID) enqueueDramas([playerDramaID]); });
  // 独立窗口先开播后才读到剧库，剧库到了再把简介补上
  function refreshPlayerInfo() { if (playerInfoArgs && playerInfoArgs.dramaID && window.dramaPlayer?.isOpen()) renderPlayerInfo(playerInfoArgs.dramaID, playerInfoArgs.title, playerInfoArgs.mode); }

  // ===== 剧库卡片 =====
  const playIcon = () => { const wrap = element('div', 'poster-play'); wrap.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-2 6.5 6 3.5-6 3.5v-7z"/></svg>'; return wrap; };
  function playDrama(drama) { window.dramaPlayer.open(drama.id, dramaTitle(drama)); }
  // 剧库卡片右键菜单：播放、开新窗口、加入下载；多选模式下还能直接勾选
  function dramaMenu(drama, card) {
    const resume = window.JukuHistory?.badgeText(window.JukuHistory?.get(drama.id)) || '';
    return [
      {label: resume ? '继续观看' : '播放', hint: resume, action: () => playDrama(drama)},
      ...(window.JukuWindows?.menuItems({dramaId: drama.id, title: dramaTitle(drama)}) || []),
      {separator: true},
      {label: '加入下载', action: () => enqueueDramas([drama.id])},
      cards.classList.contains('selecting') ? {label: selected.has(drama.id) ? '取消勾选' : '勾选', action: () => toggleSelected(drama.id, card)} : null
    ];
  }
  function resumeBadge(drama) {
    const entry = window.JukuHistory?.get(drama.id);
    const text = window.JukuHistory?.badgeText(entry);
    if (!text) return null;
    const badge = element('div', 'resume-badge', text);
    const bar = element('span', 'bar'); const fill = element('span'); fill.style.width = window.JukuHistory.progressPercent(entry) + '%'; bar.appendChild(fill); badge.appendChild(bar);
    return badge;
  }
  function renderCard(drama) {
    const card = element('div', 'card' + (selected.has(drama.id) ? ' selected' : ''));
    card.dataset.dramaId = drama.id; card.renderKey = dramaCardKey(drama);
    const poster = element('div', 'poster'); const cover = coverURL(drama);
    poster.title = '点击播放';
    if (cover) { const image = element('img', 'cover'); image.alt = dramaTitle(drama) + ' 封面'; image.loading = 'lazy'; image.decoding = 'async'; image.src = cover; image.addEventListener('error', () => {const fallback = placeholder(ffmpegStatus && ffmpegStatus !== 'ready' ? '等待 FFmpeg' : '封面加载失败'); fallback.className += ' retry-cover'; fallback.title = '点击重试；首次运行请等待 FFmpeg 准备完成'; fallback.addEventListener('click', event => {event.stopPropagation(); image.src = cover; fallback.replaceWith(image);}); image.replaceWith(fallback);}); poster.appendChild(image); } else poster.appendChild(placeholder());
    poster.appendChild(element('span', 'poster-badge', categoryName(drama)));
    poster.appendChild(playIcon());
    const badge = resumeBadge(drama); if (badge) poster.appendChild(badge);
    poster.addEventListener('click', () => { if (cards.classList.contains('selecting')) toggleSelected(drama.id, card); else playDrama(drama); });
    const body = element('div', 'card-body');
    // 标题截断到两行，完整名字挂 title 属性，鼠标悬停仍可看全
    const title = element('div', 'card-title', dramaTitle(drama)); title.title = dramaTitle(drama); title.addEventListener('click', () => playDrama(drama)); body.appendChild(title);
    body.appendChild(element('div', 'meta', dramaMetaText(drama)));
    // 正文高度固定，简介放不进来；完整简介在播放页侧栏和右键菜单里看
    const tags = element('div', 'tags'); tagsText(drama).slice(0, 3).forEach(text => tags.appendChild(element('span', 'tag', text))); body.appendChild(tags);
    // 勾选框浮在封面左上角，只在多选模式显示。
    // 卡片正文不再放「下载」按钮：首页以浏览和点击即播为主，
    // 加入下载走右键菜单或「批量下载」，卡片高度因此可以固定。
    const label = element('label', 'select-line'); const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(drama.id); checkbox.setAttribute('aria-label', '选择 ' + dramaTitle(drama)); checkbox.addEventListener('click', event => event.stopPropagation()); checkbox.addEventListener('change', () => {if (checkbox.checked) selected.add(drama.id); else selected.delete(drama.id); card.classList.toggle('selected', checkbox.checked); updateDramaSelection();}); label.appendChild(checkbox); poster.appendChild(label);
    card.appendChild(poster); card.appendChild(body); window.JukuMenu?.attach(card, () => dramaMenu(drama, card), dramaTitle(drama)); return card;
  }
  function toggleSelected(id, card) { if (selected.has(id)) selected.delete(id); else selected.add(id); card.classList.toggle('selected', selected.has(id)); const box = card.querySelector('input[type=checkbox]'); if (box) box.checked = selected.has(id); updateDramaSelection(); }
  function updateDramaSelection() { $('dramaSelection').textContent = '已选 ' + selected.size + ' 部'; $('enqueueBtn').disabled = selected.size === 0; }
  function setSelectMode(on) { $('libraryView').classList.toggle('selecting', on); cards.classList.toggle('selecting', on); if (!on) {selected.clear(); renderDramas();} updateDramaSelection(); }
  $('selectModeBtn').addEventListener('click', () => setSelectMode(!cards.classList.contains('selecting')));
  $('exitSelectBtn').addEventListener('click', () => setSelectMode(false));

  function refreshResumeBadges() {
    for (const card of cards.querySelectorAll('.card')) {
      const drama = dramaByID(card.dataset.dramaId); if (!drama) continue;
      const poster = card.querySelector('.poster'); const old = poster.querySelector('.resume-badge'); const fresh = resumeBadge(drama);
      if (old) old.remove(); if (fresh) poster.appendChild(fresh);
    }
  }

  // ===== 首页「继续观看」横向轨道 =====
  // 只读观看历史，不新增任何接口：历史里已经存了每部剧看到第几集、第几秒。
  // 点封面直接开播，续播位置仍由 player.js 内部查 resumeFor 决定，
  // 所以这里不传集数与偏移，避免两处各算一遍导致口径不一致。
  const RESUME_ROW_LIMIT = 12;              // 最多展示的部数，超出的去「全部历史」看
  const resumeRow = $('resumeRow');
  const resumeTrack = $('resumeTrack');
  // 已看完且没有下一集的剧不放进轨道：它不再是「继续」，留着只会占位置
  function resumeRowEntries() {
    const all = window.JukuHistory?.entries() || [];
    return all.filter(entry => {
      if (!entry || !(entry.lastIndex > 0)) return false;
      if (!entry.finished) return true;
      return entry.episodeCount > 0 && entry.lastIndex < entry.episodeCount;
    }).slice(0, RESUME_ROW_LIMIT);
  }
  // 用真正的 button：焦点、回车/空格触发、无障碍语义都由浏览器给，不用手写 tabIndex 和 keydown
  function renderResumeItem(entry) {
    const item = element('button', 'resume-card');
    item.type = 'button';
    item.dataset.dramaId = entry.dramaId;
    const title = entry.title || entry.dramaId;
    const badge = window.JukuHistory?.badgeText(entry) || '';
    item.title = title + (badge ? '\n' + badge : '');
    item.setAttribute('aria-label', (entry.finished ? '看下一集：' : '继续观看：') + title + (badge ? '，' + badge : ''));
    const thumb = element('div', 'resume-thumb');
    // 封面优先用历史里存的，历史没有再回退到剧库缓存（历史条目可能早于剧库补齐资料）
    const drama = dramaByID(entry.dramaId);
    const cover = entry.cover || (drama ? coverURL(drama) : '');
    if (cover) {
      const image = element('img'); image.src = cover; image.alt = ''; image.loading = 'lazy'; image.decoding = 'async';
      image.addEventListener('error', () => image.remove());
      thumb.appendChild(image);
    }
    const play = element('div', 'resume-play');
    play.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-2 6.5 6 3.5-6 3.5v-7z"/></svg>';
    thumb.appendChild(play);
    // 进度条压在缩略图底部，一眼看出还剩多少
    const bar = element('div', 'resume-bar'); const fill = element('span');
    fill.style.width = (window.JukuHistory?.progressPercent(entry) || 0) + '%';
    bar.appendChild(fill); thumb.appendChild(bar);
    item.appendChild(thumb);
    const body = element('div', 'resume-body');
    body.appendChild(element('div', 'resume-name', title));
    body.appendChild(element('div', 'resume-at', badge));
    item.appendChild(body);
    const open = () => playEntry(entry);
    item.addEventListener('click', open);
    window.JukuMenu?.attach(item, () => [
      {label: entry.finished ? '看下一集' : '继续观看', hint: badge, action: open},
      ...(window.JukuWindows?.menuItems(entry.mode === 'collection' && entry.taskId ? {taskId: entry.taskId, dramaId: entry.dramaId, title: entry.title} : {dramaId: entry.dramaId, title: entry.title}) || [])
    ], title);
    return item;
  }
  // 合集与普通剧的开播入口不同，与历史视图保持一致的分流
  function playEntry(entry) {
    if (!window.dramaPlayer) return;
    if (entry.mode === 'collection' && entry.taskId) window.dramaPlayer.openCollection(entry.taskId, entry.title, entry.dramaId);
    else window.dramaPlayer.open(entry.dramaId, entry.title || '短剧');
  }
  function renderResumeRow() {
    // 独立播放窗口没有剧库视图，容器不存在
    if (!resumeRow || !resumeTrack || window.JukuWindows?.isWindow) return;
    const list = resumeRowEntries();
    resumeRow.hidden = !list.length;
    if (!list.length) {resumeTrack.replaceChildren(); return;}
    const fragment = document.createDocumentFragment();
    for (const entry of list) fragment.appendChild(renderResumeItem(entry));
    resumeTrack.replaceChildren(fragment);
  }
  $('resumeMoreBtn')?.addEventListener('click', () => showView('history'));

  function renderDramas() {
    // 独立播放窗口不显示剧库，只留数据供简介和历史上报使用，省掉上千张卡片的渲染
    if (window.JukuWindows?.isWindow) return;
    const filtered = filteredDramas(); const mode = $('sortSelect').value; const list = window.JukuLibrarySort.sortDramas(filtered, mode); sortMessage = window.JukuLibrarySort.summary(filtered, mode); $('sortSelect').title = '排序当前已加载的剧集；缺失数据置后，热度与播放量分别排序，不同站源统计口径可能不同。' + sortMessage; updateLibraryStatus(); visibleIDs = list.map(drama => drama.id); $('dramaCount').textContent = list.length + ' / ' + dramas.length + ' 部'; updateDramaSelection();
    const previous = new Map(Array.from(cards.querySelectorAll('.card'), card => [card.dataset.dramaId, card]));
    const sameOrder = list.length === cards.children.length && list.every((drama, index) => cards.children[index].dataset.dramaId === drama.id);
    if (!sameOrder) empty(cards);
    const version = ++cardRender; let offset = 0;
    function appendBatch() { if (version !== cardRender) return; const end = Math.min(offset + 80, list.length); for (; offset < end; offset++) {
      const drama = list[offset]; let card = previous.get(drama.id);
      if (!card || card.renderKey !== dramaCardKey(drama)) card = renderCard(drama);
      else {const metadata = card.querySelector('.meta'), text = dramaMetaText(drama); if (metadata.textContent !== text) metadata.textContent = text; card.classList.toggle('selected', selected.has(drama.id)); card.querySelector('input[type=checkbox]').checked = selected.has(drama.id);}
      if (sameOrder) {if (cards.children[offset] !== card) cards.replaceChild(card, cards.children[offset]);} else cards.appendChild(card);
    } if (offset < list.length) setTimeout(appendBatch, 0); }
    appendBatch(); if (!list.length) cards.appendChild(element('div', 'empty', dramas.length ? '没有符合筛选条件的视频' : '暂无已加载视频，点击右上角“更新剧库”。'));
  }
  async function loadDramas(update) {
    if (libraryRequest) {libraryReload = true; return;} libraryRequest = true; clearTimeout(libraryTimer); updateLibraryButton();
    const query = update ? '?update=1&source=' + encodeURIComponent($('sourceSelect').value) + '&priority=' + encodeURIComponent(metadataPriorityIDs().join(',')) : '?revision=' + libraryRevision;
    try {
      const result = await api('/api/ui/dramas' + query); libraryRevision = result.revision || 0;
      libraryIsLoading = !!result.loading; libraryMetadataRemaining = result.metadataRemaining || {};
      if (Array.isArray(result.data)) {dramas.length = 0; for (const drama of result.data) if (sourceKey(drama) === 'hongguo') dramas.push(drama); rebuildSources(); rebuildChannels(false); renderDramas(); renderTasks(tasks); refreshPlayerInfo();}
      const loaded = result.loadedAt && !result.loadedAt.startsWith('0001') ? new Date(result.loadedAt).toLocaleString() : '';
      $('libraryUpdatedAt').textContent = loaded ? '更新于 ' + loaded : '';
      $('libraryUpdatedAt').title = $('libraryUpdatedAt').textContent;
      const metadata = result.metadata || {}; libraryBusyText = result.loading ? '正在更新剧库' : metadata.running ? '后台补充资料 ' + metadata.checked + '/' + metadata.total : metadata.total ? '已检查 ' + metadata.checked + ' 部，补齐 ' + metadata.updated + ' 部' + (metadata.failed ? '，' + metadata.failed + ' 部待重试' : '') : !dramas.length ? '暂无已加载数据' : ''; updateLibraryStatus();
      if (result.loading || metadata.running) libraryTimer = setTimeout(() => loadDramas(false), result.loading ? 1200 : 5000);
    } catch (error) {libraryIsLoading = false; libraryBusyText = '更新暂未完成'; updateLibraryStatus();}
    finally {libraryRequest = false; updateLibraryButton(); if (libraryReload) {libraryReload = false; loadDramas(false);}}
  }
  function updateLibraryStatus() { const text = [libraryBusyText, onlineSearchMessage, sortMessage].filter(Boolean).join(' · '); $('libraryStatus').textContent = text; $('libraryStatus').title = text; }
  function resetOnlineSearch() { searchSequence++; if (searchController) searchController.abort(); searchController = null; onlineSearchQuery = ''; onlineSearchIDs.clear(); onlineSearchMessage = ''; $('onlineSearchBtn').disabled = false; $('onlineSearchBtn').textContent = '联网搜索'; updateLibraryStatus(); }
  async function searchOnline() {
    if ($('sourceSelect').value && $('sourceSelect').value !== 'hongguo') return;
    const keyword = $('searchInput').value.trim(); if (!keyword) {setMessage('请先输入搜索词', true); return;} if (searchController) return;
    resetOnlineSearch(); const sequence = searchSequence; const controller = new AbortController(); searchController = controller;
    $('onlineSearchBtn').disabled = true; $('onlineSearchBtn').textContent = '搜索中'; onlineSearchMessage = '正在联网搜索红果'; updateLibraryStatus();
    try {
      const result = await api('/api/ui/search?q=' + encodeURIComponent(keyword), {signal: controller.signal});
      if (sequence !== searchSequence || keyword !== $('searchInput').value.trim()) return;
      const matches = (Array.isArray(result.data) ? result.data : []).filter(drama => sourceKey(drama) === 'hongguo');
      onlineSearchQuery = keyword.toLowerCase(); onlineSearchIDs = new Set(matches.map(drama => drama.id));
      const positions = new Map(dramas.map((drama, index) => [drama.id, index])); for (const drama of matches) {const position = positions.get(drama.id); if (position === undefined) {positions.set(drama.id, dramas.length); dramas.push(drama);} else dramas[position] = drama;}
      onlineSearchMessage = matches.length ? '联网返回 ' + matches.length + ' 部红果' + (result.total > matches.length ? '（首批匹配）' : '') : '联网暂无匹配';
      if (matches.length && result.saved === false) onlineSearchMessage += '，缓存未保存';
      rebuildSources(); rebuildChannels(false); renderDramas(); updateLibraryStatus(); libraryRevision = 0; await loadDramas(false);
    } catch (error) {if (sequence === searchSequence && !controller.signal.aborted) {onlineSearchMessage = '联网搜索暂不可用，本地筛选仍可使用'; updateLibraryStatus();}}
    finally {if (sequence === searchSequence) {searchController = null; $('onlineSearchBtn').disabled = false; $('onlineSearchBtn').textContent = '联网搜索';}}
  }

  // ===== 下载合集 =====
  function number(value) { const result = Number(value); return Number.isFinite(result) ? result : 0; }
  function formatBytes(value) { let count = number(value); if (count <= 0) return '0 B'; const units = ['B', 'KB', 'MB', 'GB', 'TB']; let index = 0; while (count >= 1024 && index < units.length - 1) {count /= 1024; index++;} return (index ? count.toFixed(count >= 100 ? 0 : 1) : Math.round(count)) + ' ' + units[index]; }
  function formatTime(value) { const seconds = Math.max(0, Math.floor(number(value))); if (!seconds) return '—'; const minutes = Math.floor(seconds / 60); return (minutes ? minutes + '分' : '') + (seconds % 60) + '秒'; }
  function statusText(status) { return {queued: '排队中', parsing: '解析中', running: '下载中', success: '成功', failed: '失败', paused: '已暂停', canceled: '已取消'}[status] || status; }
  function releaseText(status) { return {finished: '完结', ongoing: '未完结', unknown: '状态未知'}[status] || '状态未知'; }
  function phaseText(task) { if (task.removeRequested) return '正在停止并清理'; if (task.pauseRequested) return '暂停中'; if (task.cancelRequested) return '取消中'; return {preparing: '准备 FFmpeg', starting: '准备下载', resolving: '解析播放地址', retrying: '等待重试'}[task.phase] || statusText(task.status); }
  function progressText(task) { if (task.status === 'success') return '100%'; if (task.status === 'running' && !number(task.mediaTotalSeconds) && !number(task.totalBytes)) return phaseText(task) + ' · 进度未知'; return Math.max(0, Math.min(100, number(task.progress))) + '%'; }
  function progressBar(percent) { const bar = element('div', 'progress'); const fill = element('span'); fill.style.width = Math.max(0, Math.min(100, number(percent))) + '%'; bar.appendChild(fill); return bar; }
  function episodeLabel(task) { const sequence = number(task.episode || task.index); return sequence > 0 ? '第' + String(sequence).padStart(3, '0') + '集' : task.title || '章节'; }
  function groupStats(group) { const stats = {success: 0, failed: 0, running: 0, parsing: 0, queued: 0, paused: 0, canceled: 0, percent: 0, bytes: 0, speed: 0}; group.tasks.forEach(task => {if (task.status in stats) stats[task.status]++; stats.percent += task.status === 'success' ? 100 : number(task.progress); stats.bytes += number(task.downloadedBytes); if (task.status === 'running') stats.speed += number(task.speedBytesPerSecond);}); stats.percent = group.tasks.length ? Math.floor(stats.percent / group.tasks.length) : 0; return stats; }
  function buildGroups() { const byID = new Map(); tasks.forEach(task => {const id = task.dramaId || task.dramaTitle || task.id; let group = byID.get(id); if (!group) {group = {id, title: task.dramaTitle || '短剧', tasks: [], release: 'unknown'}; byID.set(id, group);} group.tasks.push(task); if (task.releaseStatus) group.release = task.releaseStatus;}); return Array.from(byID.values()); }
  function groupMatches(group) { const keyword = $('taskSearch').value.trim().toLowerCase(); if (keyword && !group.title.toLowerCase().includes(keyword)) return false; const release = $('releaseStatus').value; if (release && group.release !== release) return false; const status = $('taskStatus').value; const stats = groupStats(group); if (status === 'completed') return stats.success === group.tasks.length; if (status === 'unfinished') return stats.success !== group.tasks.length; if (status === 'failed') return stats.failed > 0; if (status === 'running') return stats.running + stats.parsing + stats.queued > 0; if (status === 'paused') return stats.paused > 0; if (status === 'canceled') return stats.canceled > 0; return true; }
  function selectGroup(group, checked) { group.tasks.forEach(task => {if (checked) selectedTasks.add(task.id); else selectedTasks.delete(task.id);}); renderTasks(tasks); }
  function selectedTaskList() { return tasks.filter(task => selectedTasks.has(task.id)); }
  function selectedGroupIDs() { return Array.from(new Set(selectedTaskList().map(task => task.dramaId))); }
  function updateTaskSelection() { const visible = new Set(visibleGroups.flatMap(group => group.tasks.map(task => task.id))); const hidden = selectedTaskList().filter(task => !visible.has(task.id)).length; $('taskSelection').textContent = '已选 ' + selectedTasks.size + ' 集 / ' + selectedGroupIDs().length + ' 部' + (hidden ? '（隐藏 ' + hidden + ' 集）' : ''); for (const id of ['pauseSelectedBtn', 'resumeSelectedBtn', 'cancelSelectedBtn', 'retrySelectedBtn', 'updateSelectedBtn', 'mergeSelectedBtn', 'clearTasksBtn']) $(id).disabled = selectedTasks.size === 0; }
  function updateDownloadsBadge() { const active = tasks.filter(task => ['running', 'queued', 'parsing'].includes(task.status)).length; $('downloadsBadge').textContent = active ? String(active) : ''; $('downloadsBadge').title = active ? active + ' 个分集进行中' : ''; }
  function renderTasks(next) { tasks = next; const existing = new Set(tasks.map(task => task.id)); selectedTasks.forEach(id => {if (!existing.has(id)) selectedTasks.delete(id);}); updateDownloadsBadge(); if (views.downloads.hidden && tasks.length) {updateTaskSelection(); return;} const all = buildGroups(); visibleGroups = all.filter(groupMatches); $('taskCount').textContent = visibleGroups.length + ' / ' + all.length; empty(groupsEl); visibleGroups.forEach(group => groupsEl.appendChild(renderGroup(group))); if (!visibleGroups.length) groupsEl.appendChild(element('div', 'empty', tasks.length ? '没有符合筛选条件的合集' : '还没有下载任务。在剧库里右键卡片选择“加入下载”，或用“批量下载”多选加入。')); updateTaskSelection(); }
  function renderGroup(group) {
    const stats = groupStats(group); const wrap = element('div', 'group' + (openGroups.has(group.id) ? ' open' : '')); const head = element('div', 'group-head'); const heading = element('div', 'group-heading'); const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.setAttribute('aria-label', '选择合集 ' + group.title); const selectedCount = group.tasks.filter(task => selectedTasks.has(task.id)).length; checkbox.checked = selectedCount === group.tasks.length; checkbox.indeterminate = selectedCount > 0 && !checkbox.checked; checkbox.addEventListener('change', () => selectGroup(group, checkbox.checked)); heading.appendChild(checkbox); const info = element('div'); info.appendChild(element('div', 'group-title', '《' + group.title + '》')); info.appendChild(element('div', 'small', releaseText(group.release) + ' · 共 ' + group.tasks.length + ' 集 · 成功 ' + stats.success + ' · 失败 ' + stats.failed + ' · 下载 ' + stats.running + ' · 解析 ' + stats.parsing + ' · 排队 ' + stats.queued + ' · 暂停 ' + stats.paused +' · 取消 ' + stats.canceled)); heading.appendChild(info); head.appendChild(heading); head.appendChild(progressBar(stats.percent)); head.appendChild(element('div', 'small', stats.percent + '% · 已写入 ' + formatBytes(stats.bytes) + ' · ' + (stats.speed > 0 ? formatBytes(stats.speed) + '/s' : '速度 —')));
    const merge = mergeStates[group.id]; if (merge) head.appendChild(element('div', merge.error ? 'error small' : 'small', '合并：' + ({running: '进行中', success: '完成', failed: '失败'}[merge.status] || merge.status) + ' ' + (merge.progress || 0) + '%' + (merge.detail ? ' · ' + merge.detail : '') + (merge.outputPath ? ' · ' + merge.outputPath : '') + (merge.error ? ' · ' + merge.error : '')));
    const actions = element('div', 'group-actions'); actions.appendChild(button(openGroups.has(group.id) ? '收起' : '展开', () => {if (openGroups.has(group.id)) openGroups.delete(group.id); else openGroups.add(group.id); renderTasks(tasks);}));
    const firstPlayable = group.tasks.filter(task => task.playable).sort((left, right) => number(left.index) - number(right.index))[0]; actions.appendChild(button('播放', () => window.dramaPlayer.openCollection(firstPlayable.id, group.title, firstPlayable.dramaId || group.id), !firstPlayable, 'secondary collection-play-button'));
    actions.appendChild(button('暂停本剧', () => taskAction('pause', [], [group.id]), stats.running + stats.queued + stats.parsing === 0));
    actions.appendChild(button('继续本剧', () => taskAction('resume', [], [group.id]), stats.paused === 0));
    actions.appendChild(button('取消本剧', () => taskAction('cancel', [], [group.id]), stats.running + stats.queued + stats.parsing + stats.paused === 0));
    actions.appendChild(button('重试失败', () => taskAction('retry', [], [group.id]), stats.failed + stats.canceled === 0));
    actions.appendChild(button('更新本剧', () => updateGroups([group.id]))); actions.appendChild(button('合并本剧', () => mergeGroups([group.id]), stats.success === 0)); head.appendChild(actions); wrap.appendChild(head);
    const list = element('div', 'episode-list'); if (openGroups.has(group.id)) group.tasks.forEach(task => list.appendChild(renderEpisode(task))); wrap.appendChild(list);
    window.JukuMenu?.attach(head, () => firstPlayable ? [{label: '播放合集', action: () => window.dramaPlayer.openCollection(firstPlayable.id, group.title, firstPlayable.dramaId || group.id)}, ...(window.JukuWindows?.menuItems({taskId: firstPlayable.id, dramaId: firstPlayable.dramaId || group.id, title: group.title}) || [])] : [], group.title);
    return wrap;
  }
  function renderEpisode(task) {
    const row = element('div', 'episode'); const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = selectedTasks.has(task.id); checkbox.setAttribute('aria-label', '选择 ' + episodeLabel(task)); checkbox.addEventListener('change', () => {if (checkbox.checked) selectedTasks.add(task.id); else selectedTasks.delete(task.id); renderTasks(tasks);}); row.appendChild(checkbox); const content = element('div', 'episode-main'); const heading = element('div', 'episode-heading'); heading.appendChild(element('span', 'pill ' + task.status, phaseText(task))); heading.appendChild(element('strong', '', task.status === 'parsing' || task.title === '章节获取失败' ? task.title : episodeLabel(task))); content.appendChild(heading); content.appendChild(element('div', 'small episode-path', task.path || '')); if (task.error) content.appendChild(element('div', 'error', task.error)); content.appendChild(progressBar(task.progress)); content.appendChild(element('div', 'small', progressText(task) + ' · 已写入 ' + formatBytes(task.downloadedBytes) + (number(task.totalBytes) ? ' / ' + formatBytes(task.totalBytes) : '') + ' · ' + (number(task.speedBytesPerSecond) > 0 ? formatBytes(task.speedBytesPerSecond) + '/s' : '速度 —'))); content.appendChild(element('div', 'small', '已用 ' + formatTime(task.elapsedSeconds) + ' · 剩余 ' + formatTime(task.remainingSeconds) + ' · 尝试 ' + (task.attempt || 0)));
    const actions = element('div', 'episode-actions'); if (task.playable) actions.appendChild(button('播放', () => window.dramaPlayer.openCollection(task.id, task.dramaTitle, task.dramaId), false, 'secondary episode-play-button')); if (['running', 'queued', 'parsing'].includes(task.status)) actions.appendChild(button('暂停', () => taskAction('pause', [task.id]), task.pauseRequested)); if (task.status === 'paused') actions.appendChild(button('继续', () => taskAction('resume', [task.id]))); if (['running', 'queued', 'parsing', 'paused'].includes(task.status)) actions.appendChild(button('取消', () => taskAction('cancel', [task.id]), task.cancelRequested)); if (['failed', 'canceled'].includes(task.status)) actions.appendChild(button('重试', () => taskAction('retry', [task.id]))); content.appendChild(actions); row.appendChild(content);
    if (task.playable) window.JukuMenu?.attach(row, () => [{label: '播放本集', action: () => window.dramaPlayer.openCollection(task.id, task.dramaTitle, task.dramaId)}, ...(window.JukuWindows?.menuItems({taskId: task.id, dramaId: task.dramaId, title: task.dramaTitle}) || [])], task.dramaTitle + ' · ' + episodeLabel(task));
    return row;
  }
  async function retryFFmpeg() { try {await post('/api/ui/ffmpeg', {}); setMessage('已重新准备 FFmpeg，下载进度会自动更新'); await pollTasks();} catch (error) {setMessage(error.message, true);} }
  function renderFFmpeg(state) { if (!state) return; const retryCovers = ffmpegStatus && ffmpegStatus !== 'ready' && state.status === 'ready'; ffmpegStatus = state.status; let text = state.detail || '首次使用时自动准备 FFmpeg'; if (state.status === 'downloading' && number(state.totalBytes) > 0) text += ' · ' + formatBytes(state.downloadedBytes) + ' / ' + formatBytes(state.totalBytes); if (state.error) text += '：' + state.error; for (const id of ['ffmpegNotice', 'ffmpegSettingsStatus', 'ffmpegBanner']) {const target = $(id); empty(target); target.appendChild(element('span', state.status === 'failed' ? 'error' : '', id === 'ffmpegBanner' ? (state.status === 'failed' ? 'FFmpeg 准备失败，封面与播放暂不可用' : '正在准备 FFmpeg，封面与播放稍后可用' + (state.status === 'downloading' && number(state.totalBytes) > 0 ? ' · ' + Math.floor(number(state.downloadedBytes) / number(state.totalBytes) * 100) + '%' : '')) : text)); if (state.status === 'failed') target.appendChild(button(id === 'ffmpegBanner' ? '重试' : '重试下载 FFmpeg', retryFFmpeg)); if (id !== 'ffmpegSettingsStatus') target.hidden = !['downloading', 'verifying', 'failed'].includes(state.status); if (id === 'ffmpegBanner') {target.classList.toggle('error', state.status === 'failed'); target.title = text;}} if (retryCovers) cards.querySelectorAll('.retry-cover').forEach(fallback => fallback.click()); window.dramaPlayer?.updateDependency(state, text); }
  async function pollTasks() { if (taskRequest) return; taskRequest = true; try {const result = await api('/api/ui/tasks'); mergeStates = result.merges || {}; renderTasks(result.data || []); renderFFmpeg(result.ffmpeg);} catch (error) {$('taskError').textContent = '任务刷新失败：' + error.message;} finally {taskRequest = false;} }
  async function enqueueDramas(ids) { if (!ids.length) {setMessage('请先勾选剧库中的短剧', true); return;} $('enqueueBtn').disabled = true; try {await post('/api/ui/download', {ids}); const names = ids.length === 1 ? '《' + dramaTitle(dramaByID(ids[0]) || {}) + '》' : ids.length + ' 部'; setMessage('已加入下载：' + names + '，可在“下载”页查看进度'); await pollTasks(); if (cards.classList.contains('selecting')) setSelectMode(false);} catch (error) {setMessage('加入队列失败：' + error.message, true);} finally {$('enqueueBtn').disabled = selected.size === 0;} }
  async function updateGroups(ids) { if (!ids.length) {setMessage('请先勾选下载合集', true); return;} try {await post('/api/ui/update', {ids}); setMessage('已提交 ' + ids.length + ' 部更新检查，已有文件保留，只补充新增或缺失分集'); await pollTasks();} catch (error) {$('taskError').textContent = '更新失败：' + error.message;} }
  async function taskAction(action, ids, dramaIds = []) { const count = dramaIds.length || ids.length; const unit = dramaIds.length ? ' 部合集' : ' 个任务'; if (!count) {setMessage('所选任务中没有可执行此操作的项', true); return;} if (action === 'cancel' && !confirm('取消所选 ' + count + unit + '？已完成文件保留，可稍后重试。')) return; try {const result = await post('/api/ui/tasks/' + action, dramaIds.length ? {dramaIds} : {ids}); $('taskError').textContent = ''; if (result.data) renderTasks(result.data); setMessage('已提交' + ({pause: '暂停', resume: '继续', cancel: '取消', retry: '重试'}[action] || action) + '：' + count + unit); await pollTasks();} catch (error) {$('taskError').textContent = '操作失败：' + error.message;} }
  async function clearTasks() { const ids = selectedTaskList().map(task => task.id); if (!ids.length) {setMessage('请先勾选需要清理的任务', true); return;} if (!confirm('清理勾选的 ' + ids.length + ' 个任务记录？进行中的任务会先停止；已下载视频不会删除。')) return; try {const result = await post('/api/ui/tasks/clear', {ids}); ids.forEach(id => selectedTasks.delete(id)); renderTasks(result.data || []); setMessage('已清理 ' + (result.removed || 0) + ' 个任务' + (result.pending ? '，另有 ' + result.pending + ' 个正在停止后清理' : ''));} catch (error) {$('taskError').textContent = '清理失败：' + error.message;} }
  async function mergeGroups(ids) { if (!ids.length) {setMessage('请先勾选下载合集', true); return;} const deleteEpisodes = $('deleteEpisodesAfterMerge').checked; if (deleteEpisodes && !confirm('合并成功后删除 ' + ids.length + ' 个合集已合并的分集文件，确认继续？')) return; setMessage('正在合并 ' + ids.length + ' 部，下载区会显示进度'); try {const result = await post('/api/ui/merge', {dramaIds: ids, deleteEpisodes}); const items = result.data || []; const failed = items.filter(item => !item.ok); setMessage('合并完成：成功 ' + (items.length - failed.length) + '，失败 ' + failed.length, failed.length > 0); await pollTasks();} catch (error) {$('taskError').textContent = '合并失败：' + error.message;} }

  // ===== 设置 =====
  function refreshConfigFields() { $('downloadDirectory').value = config.outputDirSetting || config.outputDir || './短剧下载'; $('downloadDirectoryHint').textContent = (config.restartRequired ? '已保存新目录，重启后生效。' : '') + '选择程序所在电脑的文件夹，或输入相对/绝对路径。重启后新合集使用新目录，原任务和文件保留。'; $('downloadConcurrency').value = config.concurrency || 2; $('requestConcurrency').value = config.requestConcurrency || 2; $('requestInterval').value = config.requestIntervalMs || 500; $('proxyMode').value = config.proxyMode || 'auto'; $('proxyURL').value = config.proxyURL || ''; $('proxyUsername').value = ''; $('proxyPassword').value = ''; $('proxyPassword').placeholder = config.proxyHasAuth ? '已保存，留空保留认证' : ''; updateProxyFields(); $('configText').textContent = '当前输出：' + (config.outputDir || '') + ' · 下载并发 ' + (config.concurrency || 2) + ' · ' + (config.network || '') + ' · FFmpeg ' + (config.ffmpeg || ''); }
  function updateProxyFields() { const disabled = $('proxyMode').value !== 'manual'; for (const name of ['proxyURL', 'proxyUsername', 'proxyPassword']) $(name).disabled = disabled; }
  async function loadConfig() { try {config = await api('/api/ui/config'); refreshConfigFields();} catch (error) {$('configText').textContent = '配置读取失败：' + error.message;} }
  async function saveSettings() {
    const settings = {outputDir: $('downloadDirectory').value.trim(), concurrency: number($('downloadConcurrency').value), requestConcurrency: number($('requestConcurrency').value), requestIntervalMs: number($('requestInterval').value)};
    try {
      const mode = $('proxyMode').value; if (mode !== 'manual') settings.proxyURL = mode; else {const raw = $('proxyURL').value.trim(); const username = $('proxyUsername').value; const password = $('proxyPassword').value; if (!(config.proxyHasAuth && config.proxyMode === 'manual' && raw === config.proxyURL && !username && !password)) {const endpoint = new URL(raw); if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(endpoint.protocol)) throw new Error('仅支持 HTTP/HTTPS/SOCKS5 代理'); if (username || password) {endpoint.username = username; endpoint.password = password;} settings.proxyURL = endpoint.toString();}}
      $('saveSettingsBtn').disabled = true; config = await post('/api/ui/config', settings); refreshConfigFields(); $('settingsStatus').textContent = config.restartRequired ? '设置已保存；下载目录重启后生效，当前任务保持原路径' : '设置已保存并应用';
    } catch (error) {$('settingsStatus').textContent = '保存失败：' + error.message;} finally {$('saveSettingsBtn').disabled = false;}
  }
  async function checkNetwork() { $('checkNetworkBtn').disabled = true; $('settingsStatus').textContent = '正在检测已保存的网络配置、红果入口和实际媒体，最多约一分钟…'; try {const result = await post('/api/ui/network/check', {}); $('settingsStatus').textContent = (result.data || []).map(item => item.name + '：' + (item.error || [item.status ? 'HTTP ' + item.status : '', item.detail || ''].filter(Boolean).join(' · '))).join('；');} catch (error) {$('settingsStatus').textContent = '检测失败：' + error.message;} finally {$('checkNetworkBtn').disabled = false;} }
  async function chooseDownloadDirectory() { const pick = $('browseDirectoryBtn'); if (pick.disabled) return; pick.disabled = true; $('settingsStatus').textContent = '请在系统窗口中选择下载文件夹…'; try {const result = await post('/api/ui/directory/pick', {initialPath: $('downloadDirectory').value}); if (result.canceled) {$('settingsStatus').textContent = '已取消选择，原目录未修改'; return;} $('downloadDirectory').value = result.selectionPath || result.path; $('settingsStatus').textContent = '已选择文件夹，请点击“保存并应用”';} catch (error) {$('settingsStatus').textContent = '选择文件夹失败：' + error.message;} finally {pick.disabled = false;} }
  $('browseDirectoryBtn').addEventListener('click', chooseDownloadDirectory);

  // ===== 事件绑定与启动 =====
  rebuildSources(); $('searchInput').value = ''; $('sourceSelect').value = 'hongguo'; $('channelSelect').value = '';
  try {const savedSort = localStorage.getItem('juku.librarySort'); $('sortSelect').value = window.JukuLibrarySort.modes.includes(savedSort) ? savedSort : 'default';} catch (_) {}
  $('sortSelect').addEventListener('change', () => {try {localStorage.setItem('juku.librarySort', $('sortSelect').value);} catch (_) {} renderDramas(); $('libraryScroll').scrollTop = 0; if (sortMessage) setMessage(sortMessage);});
  window.JukuRankings.init({api, post, getSource: () => $('sourceSelect').value, sourceLabel, onLibraryChanged: () => {libraryRevision = 0; loadDramas(false);}, onDownloadsChanged: pollTasks, play: (id, title) => window.dramaPlayer.open(id, title)});
  $('taskSearch').value = ''; $('taskStatus').value = ''; $('releaseStatus').value = '';
  $('refreshBtn').addEventListener('click', () => loadDramas(true)); $('searchInput').addEventListener('input', () => {resetOnlineSearch(); renderDramas();}); $('sourceSelect').addEventListener('change', () => {resetOnlineSearch(); rebuildChannels(true); renderDramas();}); $('channelSelect').addEventListener('change', renderDramas);
  $('onlineSearchBtn').addEventListener('click', searchOnline); $('searchInput').addEventListener('keydown', event => {if (event.key === 'Enter' && !event.isComposing) {event.preventDefault(); searchOnline();}});
  $('selectVisibleBtn').addEventListener('click', () => {visibleIDs.forEach(id => selected.add(id)); renderDramas();}); $('invertVisibleBtn').addEventListener('click', () => {visibleIDs.forEach(id => {if (selected.has(id)) selected.delete(id); else selected.add(id);}); renderDramas();}); $('deselectDramasBtn').addEventListener('click', () => {selected.clear(); renderDramas();}); $('enqueueBtn').addEventListener('click', () => enqueueDramas(Array.from(selected)));
  for (const name of ['taskStatus', 'releaseStatus']) $(name).addEventListener('change', () => renderTasks(tasks)); $('taskSearch').addEventListener('input', () => renderTasks(tasks));
  $('selectGroupsBtn').addEventListener('click', () => {visibleGroups.forEach(group => group.tasks.forEach(task => selectedTasks.add(task.id))); renderTasks(tasks);}); $('invertGroupsBtn').addEventListener('click', () => {visibleGroups.forEach(group => {const checked = !group.tasks.every(task => selectedTasks.has(task.id)); group.tasks.forEach(task => {if (checked) selectedTasks.add(task.id); else selectedTasks.delete(task.id);});}); renderTasks(tasks);}); $('deselectGroupsBtn').addEventListener('click', () => {selectedTasks.clear(); renderTasks(tasks);});
  for (const [id, action, statuses] of [['pauseSelectedBtn', 'pause', ['running', 'queued', 'parsing']], ['resumeSelectedBtn', 'resume', ['paused']], ['cancelSelectedBtn', 'cancel', ['running', 'queued', 'parsing', 'paused']], ['retrySelectedBtn', 'retry', ['failed', 'canceled']]]) $(id).addEventListener('click', () => taskAction(action, selectedTaskList().filter(task => statuses.includes(task.status)).map(task => task.id)));
  $('updateSelectedBtn').addEventListener('click', () => updateGroups(selectedGroupIDs())); $('mergeSelectedBtn').addEventListener('click', () => mergeGroups(selectedGroupIDs())); $('clearTasksBtn').addEventListener('click', clearTasks); $('proxyMode').addEventListener('change', updateProxyFields); $('saveSettingsBtn').addEventListener('click', saveSettings); $('checkNetworkBtn').addEventListener('click', checkNetwork);
  $('openSettingsBtn').addEventListener('click', () => {$('settingsPanel').showModal();}); $('closeSettingsBtn').addEventListener('click', () => {$('settingsPanel').close();}); $('batchMenu').addEventListener('click', event => {if (event.target.tagName === 'BUTTON') $('batchMenu').open = false;});
  window.addEventListener('downloadsChanged', pollTasks);
  // 历史一变（看完一集、删除记录、其他窗口上报）就同时刷新卡片角标和继续观看轨道
  window.JukuHistory?.onChange(() => {refreshResumeBadges(); renderResumeRow();});
  // 切到下载页时立刻渲染一次（隐藏时只更新角标，不渲染列表）
  document.querySelector('.nav button[data-view="downloads"]').addEventListener('click', () => renderTasks(tasks));

  window.appShell = {showView, leavePlayer, renderPlayerInfo, refreshViews: applyViewVisibility, currentView: () => currentView, dramaInfo: id => {const drama = dramaByID(id); return drama ? {title: dramaTitle(drama), cover: coverURL(drama), channel: categoryName(drama), episodeCount: Number(episodeCount(drama)) || 0} : null;}, message: setMessage, enqueue: enqueueDramas};

  // ===== 独立播放窗口：隐藏导航，按地址参数直接开播 =====
  const historyReady = window.JukuHistory?.load();
  function bootPlayerWindow() {
    const windows = window.JukuWindows;
    const params = windows.params;
    document.body.classList.add('window-mode');
    if (windows.mode === 'mini') document.body.classList.add('window-mini');
    $('closePlayerBtn').textContent = '× 关闭窗口';
    $('closePlayerBtn').title = '关闭这个窗口（Esc）';
    showView('player');
    const dramaId = params.get('play') || '';
    const taskId = params.get('collection') || '';
    const title = params.get('title') || '短剧';
    const index = Number(params.get('ep')) || 0;
    const offset = Number(params.get('t')) || 0;
    if (!dramaId && !taskId) {windows.closeSelf(); return;}
    // 没指定集数时按观看历史续播，所以先等历史读完
    Promise.resolve(historyReady).then(() => {
      if (taskId) window.dramaPlayer.openCollection(taskId, title, dramaId, index, offset);
      else window.dramaPlayer.open(dramaId, title, index, offset);
      if (windows.mode === 'mini') window.dramaPlayer.setWebFullscreen(true);
    });
  }
  const windowMode = Boolean(window.JukuWindows?.isWindow);
  const initialView = location.hash.replace('#', '');
  if (windowMode) bootPlayerWindow(); else showView(views[initialView] && initialView !== 'player' ? initialView : 'library');
  // 独立窗口只放一部剧，任务列表放慢刷新；别的窗口上报的进度通过广播同步过来
  loadConfig(); loadDramas(false); pollTasks(); setInterval(pollTasks, windowMode ? 6000 : 2000);
  let historySyncTimer = null;
  window.JukuWindows?.on('history', () => {clearTimeout(historySyncTimer); historySyncTimer = setTimeout(() => window.JukuHistory?.load(), 800);});
})();
