import { el, fmtClock, fmtDate, relTime } from '../core/util.js';
import { icon } from '../core/icons.js';
import { State } from '../core/state.js';
import { Notifications } from '../core/notifications.js';
import { getApp } from '../core/registry.js';

export const Shade = {
  el: null, tilesEl: null, listEl: null, onOpenSettings: null,

  build({ onOpenSettings }) {
    this.onOpenSettings = onOpenSettings;
    const head = el('div', { class: 'shade-head' });
    head.append(
      el('div', { class: 'st' }, el('div', { text: fmtClock() }), el('div', { style: { fontSize: '11px', opacity: '.7' }, text: fmtDate() })),
      el('div', { style: { display: 'flex', gap: '4px' } },
        el('button', { text: 'Clear', on: { click: () => Notifications.clear() } }),
        el('button', { attrs: { 'aria-label': 'Settings' }, html: icon('settings'), on: { click: () => { this.close(); onOpenSettings(); } } }),
      ),
    );
    this.tilesEl = el('div', { class: 'qs-grid' });
    this.listEl = el('div', { class: 'notif-list' });
    this.el = el('div', { class: 'shade' }, head, this.tilesEl, this.listEl);
    this.refresh();
    return this.el;
  },

  tile({ name, iconName, on, onClick }) {
    return el('button', { class: 'qs-tile' + (on ? ' on' : ''), on: { click: onClick } },
      el('span', { html: icon(iconName) }), el('span', { class: 'qs-name', text: name }));
  },

  renderTiles() {
    const t = State.get('toggles', {}) || {};
    const sec = State.get('security', {}) || {};
    const set = (path, val) => { State.set(path, val); this.renderTiles(); };
    const tog = (path, cur) => set(path, !cur);
    const routing = t.routing || 'direct';
    const routeNext = { direct: 'vpn', vpn: 'tor', tor: 'direct' };
    const theme = State.get('settings.theme', 'dark');

    const tiles = [
      this.tile({ name: 'Wi‑Fi', iconName: t.wifi ? 'wifi' : 'wifiOff', on: !!t.wifi && !t.airplane, onClick: () => tog('toggles.wifi', t.wifi) }),
      this.tile({ name: 'Bluetooth', iconName: 'bluetooth', on: !!t.bluetooth, onClick: () => tog('toggles.bluetooth', t.bluetooth) }),
      this.tile({ name: t.airplane ? 'Airplane' : 'Airplane', iconName: 'airplane', on: !!t.airplane, onClick: () => tog('toggles.airplane', t.airplane) }),
      this.tile({ name: 'Do Not Disturb', iconName: 'dnd', on: !!t.dnd, onClick: () => tog('toggles.dnd', t.dnd) }),
      this.tile({ name: 'Flashlight', iconName: 'flashlight', on: !!t.flashlight, onClick: () => tog('toggles.flashlight', t.flashlight) }),
      this.tile({ name: 'Location', iconName: 'location', on: !!t.location, onClick: () => tog('toggles.location', t.location) }),
      this.tile({ name: 'Auto‑rotate', iconName: 'rotate', on: !!t.autoRotate, onClick: () => tog('toggles.autoRotate', t.autoRotate) }),
      this.tile({ name: routing === 'tor' ? 'Tor' : routing === 'vpn' ? 'VPN' : 'Direct', iconName: routing === 'tor' ? 'tor' : 'vpn', on: routing !== 'direct', onClick: () => set('toggles.routing', routeNext[routing]) }),
      this.tile({ name: 'Sensors', iconName: 'sensor', on: sec.sensorsGlobal !== false, onClick: () => set('security.sensorsGlobal', sec.sensorsGlobal === false) }),
      this.tile({ name: theme === 'light' ? 'Light' : 'Dark', iconName: theme === 'light' ? 'sun' : 'moon', on: theme === 'light', onClick: () => set('settings.theme', theme === 'light' ? 'dark' : 'light') }),
    ];
    this.tilesEl.replaceChildren(...tiles);
  },

  renderNotifs() {
    const list = Notifications.list();
    this.listEl.replaceChildren();
    if (!list.length) { this.listEl.append(el('div', { class: 'notif-empty', text: 'No notifications' })); return; }
    for (const n of list) {
      const app = getApp(n.appId);
      const color = n.color || app?.color || '#2a3350';
      const ic = n.icon || app?.icon || 'bell';
      const row = el('div', { class: 'notif' + (n.sensitive ? ' sensitive' : '') },
        el('div', { class: 'n-icon', style: { background: color }, html: icon(ic) }),
        el('div', { class: 'n-body' },
          el('div', { class: 'n-app', text: (app?.name || n.appId) }),
          el('div', { class: 'n-title' }, el('span', { text: n.title }), el('span', { class: 'n-time', text: relTime(n.ts) })),
          n.text ? el('div', { class: 'n-text', text: n.text }) : null,
        ),
        el('button', { attrs: { 'aria-label': 'Dismiss' }, style: { color: 'var(--text-mute)', padding: '2px' }, html: icon('x'), on: { click: () => Notifications.dismiss(n.id) } }),
      );
      this.listEl.append(row);
    }
  },

  refresh() { if (!this.el) return; this.renderTiles(); this.renderNotifs(); },
  open() { this.refresh(); this.el.classList.add('open'); this.el.setAttribute('aria-hidden', 'false'); },
  close() { this.el?.classList.remove('open'); this.el?.setAttribute('aria-hidden', 'true'); },
  toggle() { this.el?.classList.contains('open') ? this.close() : this.open(); },
  isOpen() { return !!this.el?.classList.contains('open'); },
};
