// Transient UI: toasts, modal dialogs, confirm/prompt, and the runtime
// permission-request sheet. Installs the relevant Bridge hooks so core modules
// (permissions, apps) can raise UI without importing the shell.
import { el, haptic } from '../core/util.js';
import { icon, iconEl } from '../core/icons.js';
import { Bridge } from '../core/bridge.js';
import { setPerm, PERMISSIONS } from '../core/permissions.js';
import { appName } from '../core/registry.js';

const modalRoot = () => document.getElementById('modal-root');
const toastRoot = () => document.getElementById('toast-root');

export function toast(msg, { type = '', icon: ic = null, ms = 2200 } = {}) {
  const node = el('div', { class: `toast ${type}` });
  if (ic) node.append(iconEl(ic));
  node.append(el('span', { text: msg }));
  toastRoot().append(node);
  haptic(6);
  setTimeout(() => {
    node.style.transition = 'opacity .2s, transform .2s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(8px)';
    setTimeout(() => node.remove(), 200);
  }, ms);
}

/** Generic modal. actions: [{label, kind:'primary'|'danger'|'ghost'|'', value}] */
export function modal({ title, body, actions = [{ label: 'OK', kind: 'primary', value: true }], dismissable = true }) {
  return new Promise((resolve) => {
    const scrim = el('div', { class: 'modal-scrim' });
    const box = el('div', { class: 'modal', attrs: { role: 'dialog', 'aria-modal': 'true' } });
    if (title) box.append(el('h3', { text: title }));
    if (body != null) {
      if (typeof body === 'string') box.append(el('p', { text: body }));
      else box.append(body);
    }
    const done = (v) => { scrim.remove(); resolve(v); };
    const actionRow = el('div', { class: 'modal-actions' });
    for (const a of actions) {
      const cls = a.kind === 'primary' ? 'btn btn-primary'
        : a.kind === 'danger' ? 'btn btn-danger'
        : a.kind === 'ghost' ? 'btn btn-ghost' : 'btn';
      actionRow.append(el('button', { class: cls, text: a.label, on: { click: () => done(a.value) } }));
    }
    box.append(actionRow);
    scrim.append(box);
    if (dismissable) scrim.addEventListener('click', (e) => { if (e.target === scrim) done(undefined); });
    modalRoot().append(scrim);
  });
}

export function confirm({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  return modal({
    title, body: message,
    actions: [
      { label: cancelLabel, kind: 'ghost', value: false },
      { label: confirmLabel, kind: danger ? 'danger' : 'primary', value: true },
    ],
  }).then((v) => v === true);
}

export function prompt({ title, message, placeholder = '', value = '', type = 'text', confirmLabel = 'Save' }) {
  const input = el('input', { class: 'field', attrs: { type, placeholder }, value });
  const body = el('div', {});
  if (message) body.append(el('p', { text: message }));
  body.append(input);
  setTimeout(() => input.focus(), 60);
  return modal({
    title, body,
    actions: [
      { label: 'Cancel', kind: 'ghost', value: null },
      { label: confirmLabel, kind: 'primary', value: '__ok__' },
    ],
  }).then((v) => (v === '__ok__' ? input.value : null));
}

/** Runtime permission request sheet. */
export function requestPermission(appId, perm) {
  const meta = PERMISSIONS[perm] || { name: perm, desc: '', icon: 'shield' };
  const body = el('div', {});
  const head = el('div', { class: 'perm-app-head', style: { paddingTop: '0' } });
  head.append(el('div', { class: 'app-icon', style: { background: '#2a3350', width: '48px', height: '48px' }, html: icon(meta.icon) }));
  head.append(el('div', {}, el('div', { class: 'pa-name', text: appName(appId) }), el('div', { class: 'pa-sub', text: `wants ${meta.name} access` })));
  body.append(head);
  body.append(el('p', { text: meta.desc, style: { marginTop: '12px' } }));
  return modal({
    title: null, body,
    actions: [
      { label: 'Deny', kind: 'ghost', value: false },
      { label: 'Allow', kind: 'primary', value: true },
    ],
  }).then((allow) => {
    if (allow) { setPerm(appId, perm, true); toast(`${meta.name} allowed`, { type: 'ok', icon: 'check' }); }
    return !!allow;
  });
}

export function installUIBridge() {
  Bridge.install({
    toast,
    confirm,
    prompt,
    requestPermission,
  });
}
