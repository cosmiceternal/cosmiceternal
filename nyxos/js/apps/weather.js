import { registerApp } from '../core/registry.js';
import { el } from '../core/util.js';
import { icon } from '../core/icons.js';
import { bigButton } from '../shell/kit.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CONDS = ['Clear', 'Partly cloudy', 'Cloudy', 'Light rain', 'Breezy'];

// Deterministic pseudo-weather so it is stable within a day and needs no network.
function rng(seed) { let s = seed % 2147483647; if (s <= 0) s += 2147483646; return () => (s = (s * 16807) % 2147483647) / 2147483647; }

registerApp({
  id: 'weather', name: 'Weather', icon: 'weather', color: '#7aa2ff', order: 50, perms: ['location', 'network'],
  mount(root, sys, ctx) {
    const render = () => {
      const hasLoc = sys.perms.has('location');
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const seed = Math.floor(today.getTime() / 86400000) + 7;
      const r = rng(seed);
      const baseTemp = Math.round(12 + r() * 16);
      const cond = CONDS[Math.floor(r() * CONDS.length)];
      const city = hasLoc ? 'Your area' : 'Sample City';

      const hero = el('div', { class: 'weather-hero' },
        el('div', { class: 'weather-city', text: city }),
        el('div', { style: { display: 'grid', placeItems: 'center', color: 'var(--accent)', margin: '8px 0' }, html: icon('weather') }),
        el('div', { class: 'weather-temp', text: baseTemp + '°' }),
        el('div', { class: 'weather-cond', text: cond }),
      );

      const forecast = el('div', { class: 'forecast' });
      for (let i = 0; i < 6; i++) {
        const rr = rng(seed + i * 13);
        const t = Math.round(baseTemp - 3 + rr() * 8);
        const d = new Date(today.getTime() + i * 86400000);
        forecast.append(el('div', { class: 'day' },
          el('div', { class: 'd-n', text: i === 0 ? 'Today' : DAYS[d.getDay()] }),
          el('div', { style: { display: 'grid', placeItems: 'center', color: 'var(--text-dim)', margin: '4px 0' }, html: icon(rr() > 0.6 ? 'cloud' : 'weather') }),
          el('div', { class: 'd-t', text: t + '°' })));
      }

      root.replaceChildren(hero, el('div', { class: 'section-title', text: '6-day forecast' }), forecast);

      if (!hasLoc) {
        root.append(el('div', { class: 'hint', text: 'Location is off, so this is sample data. NyxOS never shares your location without permission.' }),
          el('div', { style: { marginTop: '10px' } }, bigButton('Use my location', { kind: 'primary', icon: 'location', onClick: async () => { const ok = await sys.perms.request('location'); if (ok) render(); } })));
      } else {
        root.append(el('div', { class: 'hint', text: 'Location permission granted for this app. Revoke any time in Privacy → Permissions.' }));
      }
    };
    ctx.setTitle('Weather');
    render();
  },
});
