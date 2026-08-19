import { el } from '../core/util.js';
import { icon } from '../core/icons.js';
import { installedApps } from '../core/registry.js';
import { appCell } from './appcell.js';

export function buildDrawer({ onOpenApp, onOpenAppInfo }) {
  const layer = el('div', { class: 'drawer' });
  const input = el('input', { attrs: { type: 'text', placeholder: 'Search apps', 'aria-label': 'Search apps' } });
  const search = el('div', { class: 'drawer-search' }, el('span', { html: icon('search') }), input);
  const grid = el('div', { class: 'drawer-grid' });

  const render = (q = '') => {
    const term = q.trim().toLowerCase();
    const list = installedApps().filter((a) => a.name.toLowerCase().includes(term));
    grid.replaceChildren();
    if (!list.length) { grid.append(el('div', { class: 'drawer-empty', text: 'No apps found' })); return; }
    for (const a of list) grid.append(appCell(a, {
      onOpen: (id) => { onOpenApp(id); },
      onLong: onOpenAppInfo,
    }));
  };
  input.addEventListener('input', () => render(input.value));
  render();

  layer.append(search, grid);
  layer._reset = () => { input.value = ''; render(); grid.scrollTop = 0; };
  return layer;
}
