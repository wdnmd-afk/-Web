/* 右键菜单：剧库卡片、榜单、观看历史、下载合集和播放画面共用一个菜单容器。
   条目由调用方按目标生成。桌面版本来没有系统菜单；浏览器版只在挂了菜单的元素上替换默认菜单。 */
(() => {
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  document.body.appendChild(menu);
  let cleanup = null;

  function close() {
    if (menu.hidden) return;
    menu.hidden = true;
    menu.replaceChildren();
    if (cleanup) {cleanup(); cleanup = null;}
  }
  // 先放到左上角量尺寸，再贴着鼠标位置摆放，靠边时往回收
  function place(x, y) {
    menu.style.left = '0px';
    menu.style.top = '0px';
    const left = Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4));
    const top = Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 4));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
  }
  // 模态对话框和原生全屏元素位于顶层，菜单必须挂在它们里面才看得见
  function hostFor(target) {
    const element = target instanceof Element ? target : null;
    const dialog = element ? element.closest('dialog[open]') : null;
    if (dialog) return dialog;
    const fullscreen = document.fullscreenElement || document.webkitFullscreenElement;
    if (fullscreen && element && fullscreen.contains(element)) return fullscreen;
    return document.body;
  }
  // items：{label, action, hint, disabled, danger} 或 {separator: true}；heading 为顶部说明文字
  function open(x, y, items, heading, target) {
    close();
    const list = (items || []).filter(Boolean);
    if (!list.some(item => !item.separator)) return;
    const host = hostFor(target);
    if (menu.parentElement !== host) host.appendChild(menu);
    if (heading) {
      const head = document.createElement('div');
      head.className = 'ctx-heading';
      head.textContent = heading;
      menu.appendChild(head);
    }
    let afterSeparator = true;
    for (const item of list) {
      if (item.separator) {
        if (!afterSeparator) {menu.appendChild(document.createElement('hr')); afterSeparator = true;}
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      if (item.danger) button.className = 'danger';
      const label = document.createElement('span');
      label.textContent = item.label;
      button.appendChild(label);
      if (item.hint) {
        const hint = document.createElement('span');
        hint.className = 'hint';
        hint.textContent = item.hint;
        button.appendChild(hint);
      }
      button.disabled = Boolean(item.disabled);
      button.addEventListener('click', () => {
        close();
        try {if (item.action) item.action();} catch (error) {window.appShell?.message?.(error.message || String(error), true);}
      });
      menu.appendChild(button);
      afterSeparator = false;
    }
    if (menu.lastChild && menu.lastChild.tagName === 'HR') menu.lastChild.remove();
    menu.hidden = false;
    place(x, y);
    const first = menu.querySelector('button:not(:disabled)');
    if (first) first.focus({preventScroll: true});
    const onPointer = event => {if (!menu.contains(event.target)) close();};
    const onKey = event => {
      if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); close(); return;}
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const buttons = Array.from(menu.querySelectorAll('button:not(:disabled)'));
      if (!buttons.length) return;
      const current = buttons.indexOf(document.activeElement);
      buttons[(current + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus();
    };
    const onAway = () => close();
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onAway);
    window.addEventListener('resize', onAway);
    document.addEventListener('scroll', onAway, true);
    cleanup = () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onAway);
      window.removeEventListener('resize', onAway);
      document.removeEventListener('scroll', onAway, true);
    };
  }
  // provider(event) 返回条目数组；返回空则不拦截，浏览器照常显示默认菜单。
  // 输入框、下拉框和链接上仍保留默认菜单。
  function attach(element, provider, heading) {
    element.addEventListener('contextmenu', event => {
      if (event.target.closest('input, textarea, select, a[href]')) return;
      const items = provider(event);
      if (!items || !items.length) return;
      event.preventDefault();
      event.stopPropagation();
      open(event.clientX, event.clientY, items, typeof heading === 'function' ? heading() : heading, event.target);
    });
  }
  window.JukuMenu = {open, close, attach};
})();
