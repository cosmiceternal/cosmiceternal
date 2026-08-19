import { el, fmtClock, fmtDate } from '../core/util.js';
import { icon } from '../core/icons.js';
import { State } from '../core/state.js';
import { installedApps } from '../core/registry.js';
import { getPerm } from '../core/permissions.js';
import { appCell } from './appcell.js';

function clockWidget() {
  const w = el('div', { class: 'widget', style: { textAlign: 'center' } });
  const time = el('div', { style: { fontSize: '44px', fontWeight: '300', letterSpacing: '-1px' }, text: fmtClock() });
  const date = el('div', { style: { color: 'var(--text-dim)', marginTop: '2px' }, text: fmtDate() });
  w.append(time, date);
  const id = setInterval(() => { time.textContent = fmtClock(); date.textContent = fmtDate(); }, 10000);
  return { node: w, stop: () => clearInterval(id) };
}

function weatherWidget() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let s = (Math.floor(today.getTime() / 86400000) + 7) % 2147483647; if (s <= 0) s += 2147483646;
  const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const temp = Math.round(12 + r() * 16);
  const cond = ['Clear', 'Partly cloudy', 'Cloudy', 'Light rain', 'Breezy'][Math.floor(r() * 5)];
  const hasLoc = getPerm('weather', 'location');
  return el('div', { class: 'widget' },
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
      el('div', { style: { color: 'var(--accent)' }, html: icon('weather') }),
      el('div', { style: { flex: '1' } },
        el('div', { style: { fontSize: '20px', fontWeight: '600' }, text: `${temp}° · ${cond}` }),
        el('div', { style: { fontSize: '12px', color: 'var(--text-dim)' }, text: hasLoc ? 'Your area' : 'Sample City · location off' }))));
}

function privacyWidget() {
  const apps = installedApps();
  const netBlocked = apps.filter((a) => !getPerm(a.id, 'network')).length;
  const sensorsOff = State.get('security.sensorsGlobal', true) === false;
  const routing = State.get('toggles.routing', 'direct');

  const stat = (label, value, ic) => el('div', { style: { flex: '1', textAlign: 'center' } },
    el('div', { style: { display: 'grid', placeItems: 'center', color: 'var(--accent)', marginBottom: '4px' }, html: icon(ic) }),
    el('div', { style: { fontSize: '18px', fontWeight: '700' }, text: value }),
    el('div', { style: { fontSize: '10.5px', color: 'var(--text-dim)' }, text: label }),
  );

  const w = el('div', { class: 'widget' });
  w.append(el('h4', { text: 'Privacy guard' }));
  w.append(el('div', { style: { display: 'flex', gap: '8px' } },
    stat('No internet', String(netBlocked), 'networkOff'),
    stat('Sensors', sensorsOff ? 'Off' : 'On', 'sensor'),
    stat('Routing', routing === 'direct' ? 'Direct' : routing.toUpperCase(), routing === 'tor' ? 'tor' : 'vpn'),
  ));
  return w;
}

export function buildHome({ onOpenApp, onOpenDrawer, onOpenAppInfo }) {
  const layer = el('div', { class: 'screen-layer home' });

  const scroll = el('div', { class: 'home-scroll' });
  const clock = clockWidget();
  layer._cleanup = () => clock.stop();
  scroll.append(el('div', { class: 'widget-area' }, clock.node, weatherWidget(), privacyWidget()));

  // Drawer handle
  const handle = el('button', { class: 'drawer-handle', attrs: { 'aria-label': 'Open app drawer' }, on: { click: onOpenDrawer } },
    el('span', { class: 'grip' }),
    el('span', { class: 'dh-label' }, el('span', { html: icon('chevronUp') }), el('span', { text: 'All apps' })));
  scroll.append(el('div', { class: 'lock-spacer' }), handle);

  // Dock: favorite apps
  const dockApps = installedApps().filter((a) => a.dock).slice(0, 4);
  const dock = el('div', { class: 'dock' });
  for (const a of dockApps) dock.append(appCell(a, { onOpen: onOpenApp, onLong: onOpenAppInfo }));

  layer.append(scroll, dock);

  // Swipe up anywhere on home opens the drawer.
  let startY = null;
  layer.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; }, { passive: true });
  layer.addEventListener('touchend', (e) => {
    if (startY == null) return;
    const dy = startY - e.changedTouches[0].clientY;
    if (dy > 70) onOpenDrawer();
    startY = null;
  });
  return layer;
}
