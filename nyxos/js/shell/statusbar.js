import { el, fmtClock } from '../core/util.js';
import { icon } from '../core/icons.js';
import { State } from '../core/state.js';

export const Statusbar = {
  host: null,
  battery: { level: 0.82, charging: false },

  mount(host) {
    this.host = host;
    this._initBattery();
    this.refresh();
    setInterval(() => this.refresh(), 15000);
    State.events.on('change', () => this.refresh());
    State.events.on('unlock', () => this.refresh());
    State.events.on('lock', () => this.refresh());
  },

  async _initBattery() {
    try {
      if (navigator.getBattery) {
        const b = await navigator.getBattery();
        const upd = () => { this.battery = { level: b.level, charging: b.charging }; this.refresh(); };
        b.addEventListener('levelchange', upd);
        b.addEventListener('chargingchange', upd);
        upd();
      }
    } catch { /* keep default */ }
  },

  ind(name, cls = '') { return el('span', { class: 'sb-ind ' + cls, html: icon(name) }); },

  refresh() {
    if (!this.host) return;
    const locked = State.locked;
    const t = State.get('toggles', {}) || {};
    const sec = State.get('security', {}) || {};
    const right = el('div', { class: 'sb-right' });

    const routing = t.routing;
    if (routing === 'vpn') right.append(this.ind('vpn'));
    else if (routing === 'tor') right.append(this.ind('tor'));

    if (!locked && sec.sensorsGlobal === false) right.append(this.ind('sensor'));
    if (t.dnd) right.append(this.ind('dnd'));
    if (t.airplane) right.append(this.ind('airplane'));
    else right.append(this.ind(t.wifi === false ? 'wifiOff' : 'wifi'));

    const pct = Math.round((this.battery.level ?? 0.82) * 100);
    const batt = el('span', { class: 'sb-ind' });
    batt.append(el('span', { class: 'battery', text: pct + '%' }));
    batt.append(el('span', { html: icon(this.battery.charging ? 'power' : 'battery') }));
    right.append(batt);

    this.host.replaceChildren(
      el('div', { class: 'sb-left', text: fmtClock() }),
      right,
    );
  },
};
