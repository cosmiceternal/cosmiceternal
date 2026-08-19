import { el } from '../core/util.js';
import { icon } from '../core/icons.js';
import { Notifications } from '../core/notifications.js';

/** A launcher icon: colored tile + label + unread badge. */
export function appCell(app, { onOpen, onLong } = {}) {
  const iconEl = el('div', { class: 'app-icon', style: { background: app.color }, html: icon(app.icon) });
  const count = Notifications.countForApp(app.id);
  if (count) iconEl.append(el('span', { class: 'app-badge', text: count > 9 ? '9+' : String(count) }));

  const cell = el('div', { class: 'app-cell', attrs: { role: 'button', 'aria-label': app.name } },
    iconEl,
    el('div', { class: 'app-label', text: app.name }),
  );
  cell.addEventListener('click', () => onOpen?.(app.id));
  if (onLong) {
    let timer;
    cell.addEventListener('pointerdown', () => { timer = setTimeout(() => onLong(app.id), 480); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => cell.addEventListener(ev, () => clearTimeout(timer)));
  }
  return cell;
}
