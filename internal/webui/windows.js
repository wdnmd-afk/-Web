/* 多窗口支持：把播放器开到独立窗口，几个窗口各放各的剧。
   桌面版优先请求原生子窗口（/api/ui/desktop/window），不可用时退回 window.open 弹出窗口；
   窗口之间用 BroadcastChannel 互通观看历史等变化。本文件在其他脚本之前加载。 */
(() => {
  const params = new URLSearchParams(location.search);
  const requested = params.get('window') || '';
  // mode：'' 普通页面；'player' 独立播放窗口；'mini' 紧凑小窗（画面铺满窗口）
  const mode = requested === 'mini' ? 'mini' : requested ? 'player' : '';
  const store = {
    get(key) {try {return localStorage.getItem(key);} catch (_) {return null;}},
    set(key, value) {try {localStorage.setItem(key, String(value));} catch (_) {}}
  };
  // 桌面壳能否开原生子窗口：页面加载后立即探测，右键菜单出现前通常已有结果
  let native = false;
  const ready = fetch('/api/ui/desktop', {cache: 'no-store'})
    .then(response => response.ok ? response.json() : null)
    .then(info => {native = Boolean(info && info.windows);})
    .catch(() => {});

  // 桌面版子窗口：页面来自本机服务而不是内嵌资源，Wails 不会自动注入运行时，
  // 这里从内嵌资源地址把 ipc.js 和 runtime.js 补加载进来。子窗口启动时会在地址上加 wails=1 标记。
  // 主窗口里不加载：它的来源没有放行，调用会被拦截。
  let wailsRuntime = null;
  const runtimeReady = new Promise(resolve => {
    if (!mode || params.get('wails') !== '1' || !(window.chrome && window.chrome.webview)) {resolve(false); return;}
    const paths = ['/wails/ipc.js', '/wails/runtime.js'];
    let pending = paths.length;
    for (const path of paths) {
      const script = document.createElement('script');
      script.src = 'http://wails.localhost' + path;
      script.async = false;
      script.onload = () => {
        if (--pending > 0) return;
        wailsRuntime = window.runtime && typeof window.runtime.Quit === 'function' ? window.runtime : null;
        resolve(Boolean(wailsRuntime));
      };
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    }
  });
  const runtime = () => wailsRuntime;

  function playerURL(target) {
    const query = new URLSearchParams();
    query.set('window', target.mini ? 'mini' : 'player');
    if (target.taskId) query.set('collection', target.taskId);
    if (target.dramaId) query.set('play', target.dramaId);
    if (target.title) query.set('title', target.title);
    if (target.index > 0) query.set('ep', String(target.index));
    if (target.offset > 0) query.set('t', String(Math.round(target.offset)));
    return location.origin + '/?' + query.toString();
  }

  // 普通播放窗口与小窗分别记住上次大小；首次按屏幕大小给默认值
  function rectKey(mini) {return 'juku.window.rect.' + (mini ? 'mini' : 'player');}
  function defaultRect(mini) {
    if (mini) return {width: 380, height: 700};
    return {width: Math.min(1180, Math.max(720, screen.availWidth - 200)), height: Math.min(820, Math.max(560, screen.availHeight - 120))};
  }
  function rectFor(mini) {
    try {
      const saved = JSON.parse(store.get(rectKey(mini)) || 'null');
      if (saved && saved.width >= 240 && saved.height >= 200) return {width: Math.round(saved.width), height: Math.round(saved.height)};
    } catch (_) {}
    return defaultRect(mini);
  }
  // 新窗口相对当前窗口错开一点，超出屏幕时收回可见范围
  function positionFor(rect) {
    const left = Math.max(0, Math.min((window.screenX || 0) + 60, screen.availWidth - rect.width));
    const top = Math.max(0, Math.min((window.screenY || 0) + 60, screen.availHeight - rect.height));
    return {left, top};
  }

  // 打开独立播放窗口。原生子窗口走接口；否则调用 window.open，本机接口很快，仍在用户点击的手势有效期内。
  async function openPlayer(target) {
    const url = playerURL(target);
    const rect = rectFor(target.mini);
    const title = (target.title ? target.title + ' - ' : '') + '果果剧库';
    if (native) {
      try {
        const response = await fetch('/api/ui/desktop/window', {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({url, title, width: rect.width, height: rect.height, mini: Boolean(target.mini)})
        });
        if (response.ok) return true;
      } catch (_) {}
    }
    const position = positionFor(rect);
    const features = 'popup=yes,width=' + rect.width + ',height=' + rect.height + ',left=' + position.left + ',top=' + position.top;
    const opened = window.open(url, '_blank', features);
    if (!opened) {
      window.appShell?.message?.('浏览器拦截了新窗口，请允许本站弹出窗口后重试', true);
      return false;
    }
    return true;
  }

  // 独立窗口记住自己的大小，下次打开同类窗口沿用。
  // 桌面子窗口问运行时要窗口尺寸，弹出窗口用视口尺寸，两者都是下次创建时要传的值。
  if (mode) {
    let saveTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const key = rectKey(mode === 'mini');
        const wails = runtime();
        if (wails && typeof wails.WindowGetSize === 'function') {
          wails.WindowGetSize().then(size => {if (size && size.w > 0) store.set(key, JSON.stringify({width: size.w, height: size.h}));}).catch(() => {});
        } else {
          store.set(key, JSON.stringify({width: window.innerWidth, height: window.innerHeight}));
        }
      }, 300);
    });
  }
  // 关闭独立窗口：桌面子窗口稍等片刻让进度上报发出后退出进程；弹出窗口直接关闭。
  // 直接在浏览器地址栏打开的页面关不掉，退回剧库页。
  function closeSelf() {
    const wails = runtime();
    if (wails) {setTimeout(() => wails.Quit(), 300); return;}
    window.close();
    setTimeout(() => {if (!window.closed) location.replace('/');}, 400);
  }
  // 桌面子窗口点标题栏关闭时，壳先通知页面收尾（上报进度、释放会话），页面再让进程退出
  function onCloseRequest(handler) {
    runtimeReady.then(ok => {
      const wails = runtime();
      if (ok && wails && typeof wails.EventsOn === 'function') wails.EventsOn('juku:closing', handler);
    });
  }
  let lastTitle = '';
  function applyWindowTitle() {
    const wails = runtime();
    if (wails && lastTitle && typeof wails.WindowSetTitle === 'function') wails.WindowSetTitle(lastTitle);
  }
  function setTitle(title) {
    document.title = title;
    lastTitle = title;
    applyWindowTitle();
  }
  runtimeReady.then(ok => {if (ok) applyWindowTitle();});
  // 置顶只有桌面版子窗口才做得到
  function canPin() {const wails = runtime(); return Boolean(wails && typeof wails.WindowSetAlwaysOnTop === 'function');}
  function setPinned(on) {const wails = runtime(); if (wails) wails.WindowSetAlwaysOnTop(Boolean(on));}
  // 新窗口没有用户操作记录，浏览器不让自动出声播放；桌面子窗口请宿主代替用户点一下画面。
  // 坐标为客户区物理像素。返回 false 表示当前环境做不到，页面照常等用户点击。
  function requestActivation(x, y) {
    const wails = runtime();
    if (!wails || typeof wails.EventsEmit !== 'function') return false;
    wails.EventsEmit('juku:activate', {x, y});
    return true;
  }

  // 窗口间通知。发送方自己收不到，不必去重。
  let channel = null;
  try {channel = 'BroadcastChannel' in window ? new BroadcastChannel('juku-hongguo') : null;} catch (_) {channel = null;}
  const handlers = new Map();
  if (channel) channel.addEventListener('message', event => {
    const data = event.data || {};
    for (const handler of handlers.get(data.type) || []) {try {handler(data);} catch (_) {}}
  });
  function notify(type, extra) {if (channel) {try {channel.postMessage(Object.assign({type}, extra || {}));} catch (_) {}}}
  function on(type, handler) {if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(handler);}

  // 右键菜单里的两个“开新窗口”条目，剧库、榜单、历史、下载合集共用
  function menuItems(target) {
    return [
      {label: '新窗口播放', action: () => openPlayer(target)},
      {label: '小窗播放', hint: '独立窗口', action: () => openPlayer(Object.assign({}, target, {mini: true}))}
    ];
  }

  window.JukuWindows = {mode, isWindow: Boolean(mode), params, ready, runtimeReady, native: () => native, openPlayer, playerURL, menuItems, closeSelf, onCloseRequest, setTitle, canPin, setPinned, requestActivation, notify, on};
})();
