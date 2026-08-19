import { el, fmtClock, fmtDate, haptic, relTime } from '../core/util.js';
import { icon } from '../core/icons.js';
import { State } from '../core/state.js';
import { verifyPin, setupPin } from '../core/security.js';
import { Notifications } from '../core/notifications.js';
import { getApp } from '../core/registry.js';

function lockNotifs() {
  const list = Notifications.list().slice(0, 4);
  if (!list.length) return null;
  const hide = State.get('security.hideNotifContent', true);
  const wrap = el('div', { class: 'lock-notifs' });
  for (const n of list) {
    const app = getApp(n.appId);
    const sensitiveHidden = n.sensitive && hide;
    wrap.append(el('div', { class: 'lock-notif' },
      el('div', { class: 'ln-icon', style: { background: n.color || app?.color || '#2a3350' }, html: icon(n.icon || app?.icon || 'bell') }),
      el('div', { class: 'ln-body' },
        el('div', { class: 'ln-top' }, el('span', { class: 'ln-app', text: app?.name || n.appId }), el('span', { class: 'ln-time', text: relTime(n.ts) })),
        sensitiveHidden
          ? el('div', { class: 'ln-hidden', text: 'Content hidden' })
          : el('div', { class: 'ln-title', text: n.title })),
    ));
  }
  return wrap;
}

function keypad({ onDigit, onBack, onSubmit }) {
  const grid = el('div', { class: 'keypad' });
  const mkDigit = (d, sub) => el('button', {
    on: { click: () => { haptic(8); onDigit(d); } },
  }, String(d), sub ? el('span', { class: 'sub', text: sub }) : null);
  const subs = { 2: 'ABC', 3: 'DEF', 4: 'GHI', 5: 'JKL', 6: 'MNO', 7: 'PQRS', 8: 'TUV', 9: 'WXYZ' };
  for (let d = 1; d <= 9; d++) grid.append(mkDigit(d, subs[d]));
  grid.append(el('button', { class: 'aux', attrs: { 'aria-label': 'Backspace' }, html: icon('back'), on: { click: () => { haptic(6); onBack(); } } }));
  grid.append(mkDigit(0));
  grid.append(el('button', { class: 'aux', attrs: { 'aria-label': 'Submit' }, html: icon('check'), on: { click: () => { haptic(10); onSubmit(); } } }));
  return grid;
}

function dotsRow(len) {
  const row = el('div', { class: 'pin-dots' });
  const n = Math.max(len, 0);
  for (let i = 0; i < n; i++) row.append(el('span', { class: 'dot on' }));
  return row;
}

/** Live lock screen for an existing profile. */
export function buildLock({ profileId, onUnlock, onDuress, showNotifs = false }) {
  let pin = '';
  const layer = el('div', { class: 'screen-layer lock' });

  const clock = el('div', { class: 'lock-clock', text: fmtClock() });
  const date = el('div', { class: 'lock-date', text: fmtDate() });
  const tick = setInterval(() => { clock.textContent = fmtClock(); date.textContent = fmtDate(); }, 10000);
  layer._cleanup = () => clearInterval(tick);

  const status = el('div', { class: 'lock-status' }, el('span', { html: icon('lock') }), el('span', { text: 'Encrypted · enter PIN to decrypt' }));
  const dotsWrap = el('div', {});
  const hint = el('div', { class: 'lock-hint', text: '' });

  const render = () => dotsWrap.replaceChildren(dotsRow(pin.length));
  render();

  let busy = false;
  const fail = () => {
    const dr = dotsWrap.querySelector('.pin-dots');
    if (dr) { dr.classList.add('err'); }
    haptic(40);
    hint.textContent = 'Wrong PIN';
    setTimeout(() => { pin = ''; render(); hint.textContent = ''; }, 450);
  };
  const submit = async () => {
    if (busy || pin.length < 4) { if (pin.length && pin.length < 4) fail(); return; }
    busy = true;
    hint.textContent = 'Decrypting…';
    const res = await verifyPin(profileId, pin);
    busy = false;
    if (res.status === 'ok') { clearInterval(tick); onUnlock(res.key, res.vault); }
    else if (res.status === 'duress') { clearInterval(tick); onDuress(); }
    else fail();
  };

  layer.append(
    el('div', { style: { textAlign: 'center', paddingTop: '20px' } }, clock, date, status),
    showNotifs ? (lockNotifs() || el('div', { class: 'lock-spacer' })) : el('div', { class: 'lock-spacer' }),
    el('div', { class: 'lock-spacer' }),
    dotsWrap,
    keypad({
      onDigit: (d) => { if (pin.length < 12) { pin += d; render(); } },
      onBack: () => { pin = pin.slice(0, -1); render(); },
      onSubmit: submit,
    }),
    hint,
  );
  return layer;
}

/** First-run setup: create the owner PIN and initial encrypted vault. */
export function buildSetup({ onComplete }) {
  let stage = 'create';   // 'create' | 'confirm'
  let first = '';
  let pin = '';
  const layer = el('div', { class: 'screen-layer lock' });

  const logo = el('div', { class: 'boot-logo', style: { width: '64px', height: '64px', margin: '0 auto' }, html: icon('shieldCheck') });
  const title = el('div', { class: 'lock-clock', style: { fontSize: '26px', fontWeight: '600' }, text: 'Set your PIN' });
  const sub = el('div', { class: 'lock-date', text: 'This PIN encrypts everything on this profile.' });
  const dotsWrap = el('div', {});
  const hint = el('div', { class: 'lock-hint', text: 'Choose 4–12 digits' });
  const render = () => dotsWrap.replaceChildren(dotsRow(pin.length));
  render();

  const shake = (msg) => {
    const dr = dotsWrap.querySelector('.pin-dots');
    if (dr) dr.classList.add('err');
    haptic(40); hint.textContent = msg;
    setTimeout(() => { pin = ''; render(); }, 450);
  };

  const submit = async () => {
    if (pin.length < 4) return shake('Too short — 4+ digits');
    if (stage === 'create') {
      first = pin; pin = ''; stage = 'confirm';
      title.textContent = 'Confirm PIN'; sub.textContent = 'Enter it once more.';
      hint.textContent = ''; render();
    } else {
      if (pin !== first) { stage = 'create'; first = ''; title.textContent = 'Set your PIN';
        sub.textContent = 'This PIN encrypts everything on this profile.'; return shake('PINs did not match'); }
      hint.textContent = 'Encrypting…';
      const accent = State.get('settings.accent', '#6ee7d0');
      const id = State.addProfileRecord('Owner', accent);
      const { key, vault } = await setupPin(id, first, { name: 'Owner', color: accent });
      onComplete(id, key, vault);
    }
  };

  layer.append(
    el('div', { style: { textAlign: 'center', paddingTop: '10px' } }, logo, title, sub),
    el('div', { class: 'lock-spacer' }),
    dotsWrap,
    keypad({
      onDigit: (d) => { if (pin.length < 12) { pin += d; render(); } },
      onBack: () => { pin = pin.slice(0, -1); render(); },
      onSubmit: submit,
    }),
    hint,
  );
  return layer;
}
