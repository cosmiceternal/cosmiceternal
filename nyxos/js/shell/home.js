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
  setInterval(() => { time.textContent = fmtClock(); date.textContent = fmtDate(); }, 10000);
  return w;
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
  scroll.append(el('div', { class: 'widget-area' }, clockWidget(), privacyWidget()));

  // Drawer handle
  const handle = el('button', {
    style: { margin: '8px auto 0', color: 'var(--text-dim)', fontSize: '12px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' },
    on: { click: onOpenDrawer },
  }, el('span', { html: icon('chevronUp') }), el('span', { text: 'All apps' }));
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
