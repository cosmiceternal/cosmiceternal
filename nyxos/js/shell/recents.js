import { el } from '../core/util.js';
import { icon } from '../core/icons.js';
import { getApp } from '../core/registry.js';

export function buildRecents({ recents, onOpen, onClear }) {
  const layer = el('div', { class: 'recents' });
  const scroll = el('div', { class: 'recents-scroll' });

  if (!recents.length) {
    scroll.append(el('div', { class: 'recents-empty' }, el('div', {}, 'No recent apps')));
  } else {
    for (const id of recents) {
      const app = getApp(id);
      if (!app) continue;
      const card = el('div', { class: 'recent-card', on: { click: () => onOpen(id) } },
        el('div', { class: 'rc-head' },
          el('div', { class: 'app-icon', style: { background: app.color }, html: icon(app.icon) }),
          el('div', { style: { fontSize: '13px', fontWeight: '600' }, text: app.name }),
        ),
        el('div', { class: 'rc-body', html: icon(app.icon) }),
      );
      scroll.append(card);
    }
  }

  layer.append(scroll);
  if (recents.length) {
    layer.append(el('div', { class: 'recents-actions' },
      el('button', { class: 'btn', text: 'Clear all', on: { click: onClear } })));
  }
  return layer;
}
