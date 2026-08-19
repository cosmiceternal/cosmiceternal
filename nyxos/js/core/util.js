// Small DOM + misc helpers shared across NyxOS.

/** Create an element. props: {class, text, html, on:{event:fn}, attrs, dataset, style, ...} */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'attrs') for (const [a, av] of Object.entries(v)) { if (av != null) node.setAttribute(a, av); }
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k in node) { try { node[k] = v; } catch { node.setAttribute(k, v); } }
    else node.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];
export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
export const pad2 = (n) => String(n).padStart(2, '0');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0]) % 16;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function fmtTime(date = new Date(), { seconds = false, ampm = true } = {}) {
  let h = date.getHours();
  const m = pad2(date.getMinutes());
  const s = pad2(date.getSeconds());
  if (ampm) {
    const suffix = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m}${seconds ? ':' + s : ''} ${suffix}`;
  }
  return `${pad2(h)}:${m}${seconds ? ':' + s : ''}`;
}

export function fmtClock(date = new Date()) {
  const h = date.getHours() % 12 || 12;
  return `${h}:${pad2(date.getMinutes())}`;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(date = new Date()) {
  return `${DAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}`;
}
export function fmtDateShort(ts) {
  const d = new Date(ts);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${fmtClock(d)}`;
}

export function relTime(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 45) return 'now';
  if (s < 90) return '1m';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Tiny event emitter. */
export function emitter() {
  const map = new Map();
  return {
    on(ev, fn) { (map.get(ev) || map.set(ev, new Set()).get(ev)).add(fn); return () => map.get(ev)?.delete(fn); },
    off(ev, fn) { map.get(ev)?.delete(fn); },
    emit(ev, ...args) { map.get(ev)?.forEach((fn) => { try { fn(...args); } catch (e) { console.error(e); } }); },
  };
}

export function haptic(ms = 8) { try { navigator.vibrate?.(ms); } catch {} }
