// Reusable app building blocks (settings-style rows, toggles, segmented control).
import { el } from '../core/util.js';
import { icon } from '../core/icons.js';

export function section(title) { return el('div', { class: 'section-title', text: title }); }

export function row({ icon: ic, iconColor, title, sub, value, right, onClick, danger }) {
  const node = el('div', { class: 'row' + (onClick ? ' tap' : '') + (danger ? ' danger' : '') });
  if (ic) node.append(el('div', { class: 'r-icon', style: { background: iconColor || '#2a3350' }, html: icon(ic) }));
  const main = el('div', { class: 'r-main' }, el('div', { class: 'r-title', text: title }));
  if (sub) main.append(el('div', { class: 'r-sub', text: sub }));
  node.append(main);
  if (right) node.append(right);
  else if (value != null) node.append(el('div', { class: 'r-val' }, el('span', { text: value }), el('span', { html: icon('chevronRight') })));
  else if (onClick) node.append(el('div', { class: 'r-val', html: icon('chevronRight') }));
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

export function toggle(value, onChange, { danger } = {}) {
  const t = el('div', { class: 'toggle' + (value ? ' on' : '') + (danger ? ' danger' : ''), attrs: { role: 'switch', 'aria-checked': String(!!value), tabindex: '0' } });
  const flip = () => { const nv = !t.classList.contains('on'); t.classList.toggle('on', nv); t.setAttribute('aria-checked', String(nv)); onChange(nv); };
  t.addEventListener('click', flip);
  t.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } });
  return t;
}

export function toggleRow({ icon: ic, iconColor, title, sub, value, onChange, danger, disabled }) {
  const t = toggle(value, onChange, { danger });
  if (disabled) { t.style.opacity = '.4'; t.style.pointerEvents = 'none'; }
  return row({ icon: ic, iconColor, title, sub, right: t });
}

export function list(...rows) { return el('div', { class: 'list' }, ...rows.filter(Boolean)); }

export function segmented(tabs, { onChange } = {}) {
  const seg = el('div', { class: 'seg' });
  const body = el('div', { style: { marginTop: '14px' } });
  let cur = -1;
  const buttons = tabs.map((t, i) => el('button', { text: t.name, on: { click: () => select(i) } }));
  buttons.forEach((b) => seg.append(b));
  function select(i) {
    if (i === cur) return;
    cur = i;
    buttons.forEach((b, j) => b.classList.toggle('on', j === i));
    body.replaceChildren();
    tabs[i].render(body);
    onChange?.(i);
  }
  select(0);
  return { seg, body, select, el: el('div', {}, seg, body) };
}

export function bigButton(label, { kind = '', onClick, icon: ic } = {}) {
  const b = el('button', { class: 'btn btn-block ' + (kind === 'primary' ? 'btn-primary' : kind === 'danger' ? 'btn-danger' : ''), on: { click: onClick } });
  if (ic) { b.style.display = 'flex'; b.style.alignItems = 'center'; b.style.justifyContent = 'center'; b.style.gap = '8px'; b.append(el('span', { html: icon(ic) })); }
  b.append(el('span', { text: label }));
  return b;
}
