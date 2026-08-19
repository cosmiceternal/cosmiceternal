// Mounts an app into a sandboxed layer. The app receives only its `sys`
// capability object and a small `ctx` for chrome (title, actions, back stack).
import { el } from '../core/util.js';
import { icon } from '../core/icons.js';
import { getApp } from '../core/registry.js';
import { ensureAppPerms, makeSys } from '../core/permissions.js';

export function mountApp(appId, { onClose, arg } = {}) {
  const app = getApp(appId);
  if (!app) return null;
  ensureAppPerms(appId);
  const sys = makeSys(appId);
  const backStack = [];
  const cleanups = [];

  const layer = el('div', { class: 'app-view launching' });
  layer._appId = appId;

  let h1 = null, actions = null, content;

  const ctx = {
    appId,
    sys,
    arg,
    root: null,
    onCleanup(fn) { if (typeof fn === 'function') cleanups.push(fn); },
    setTitle(t) { if (h1) h1.textContent = t; },
    setActions(list = []) {
      if (!actions) return;
      actions.replaceChildren(...list.map((a) =>
        el('button', { attrs: { 'aria-label': a.label, title: a.label }, html: icon(a.icon), on: { click: a.onClick } })));
    },
    pushBack(fn) { backStack.push(fn); },
    popBack() { return backStack.pop(); },
    clearBack() { backStack.length = 0; },
    close() { onClose(); },
  };

  if (app.chrome === false) {
    content = layer;
  } else {
    const header = el('div', { class: 'app-header' });
    const back = el('button', { class: 'back', attrs: { 'aria-label': 'Back' }, html: icon('back'),
      on: { click: () => { if (backStack.length) backStack.pop()(); else onClose(); } } });
    h1 = el('h1', { text: app.name });
    actions = el('div', { class: 'actions' });
    header.append(back, h1, actions);
    content = el('div', { class: 'app-content' });
    layer.append(header, content);
  }
  ctx.root = content;

  try {
    app.mount(content, sys, ctx);
  } catch (e) {
    console.error(`app ${appId} failed to mount`, e);
    content.append(el('div', { class: 'empty-state' },
      el('div', { html: icon('bug') }),
      el('p', { text: 'This app crashed.' }),
      el('p', { class: 'hint', text: String(e && e.message || e) })));
  }

  layer._cleanup = () => {
    for (const fn of cleanups) { try { fn(); } catch {} }
    try { app.unmount?.(); } catch {}
    try { sys.sensors?.stopAll?.(); } catch {}
  };

  return {
    layer,
    handleBack() { if (backStack.length) { backStack.pop()(); return true; } return false; },
  };
}
