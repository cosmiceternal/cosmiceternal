import { el, fmtClock, fmtDate, haptic, relTime } from '../core/util.js';
import { icon } from '../core/icons.js';
import { State } from '../core/state.js';
import { verifyPin, setupPin, getPublicMeta } from '../core/security.js';
import { Notifications } from '../core/notifications.js';
import { getApp } from '../core/registry.js';
import { bigButton } from './kit.js';

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

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function keypad({ onDigit, onBack, onSubmit, scramble = false }) {
  const grid = el('div', { class: 'keypad' });
  const subs = { 2: 'ABC', 3: 'DEF', 4: 'GHI', 5: 'JKL', 6: 'MNO', 7: 'PQRS', 8: 'TUV', 9: 'WXYZ' };
  const mkDigit = (d) => el('button', {
    on: { click: () => { haptic(8); onDigit(d); } },
  }, String(d), (!scramble && subs[d]) ? el('span', { class: 'sub', text: subs[d] }) : null);
  // Scramble randomizes every digit's position to defeat shoulder-surfing and
  // smudge attacks; the standard layout keeps 0 in the bottom-middle slot.
  const order = scramble ? shuffled([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) : [1, 2, 3, 4, 5, 6, 7, 8, 9, 0];
  for (let i = 0; i < 9; i++) grid.append(mkDigit(order[i]));
  grid.append(el('button', { class: 'aux', attrs: { 'aria-label': 'Backspace' }, html: icon('back'), on: { click: () => { haptic(6); onBack(); } } }));
  grid.append(mkDigit(order[9]));
  grid.append(el('button', { class: 'aux', attrs: { 'aria-label': 'Submit' }, html: icon('check'), on: { click: () => { haptic(10); onSubmit(); } } }));
  return grid;
}

function dotsRow(len) {
  const row = el('div', { class: 'pin-dots' });
  const n = Math.max(len, 0);
  for (let i = 0; i < n; i++) row.append(el('span', { class: 'dot on' }));
  return row;
}

function fmtDur(sec) {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}m${s ? ' ' + s + 's' : ''}`;
}

/** Live lock screen for an existing profile. */
export function buildLock({ profileId, onUnlock, onDuress, onWipe, showNotifs = false }) {
  const pub = getPublicMeta(profileId) || { mode: 'pin', fails: 0, lockUntil: 0, autoWipe: 0 };
  const isPass = pub.mode === 'passphrase';
  const scramble = !isPass && !!State.device?.scramblePin;
  let pin = '';
  const layer = el('div', { class: 'screen-layer lock' });

  const clock = el('div', { class: 'lock-clock', text: fmtClock() });
  const date = el('div', { class: 'lock-date', text: fmtDate() });
  const tick = setInterval(() => { clock.textContent = fmtClock(); date.textContent = fmtDate(); }, 10000);

  const notifsHost = el('div', { class: 'lock-notifs-host' });
  let offNotif = () => {};
  if (showNotifs) {
    const renderN = () => { const n = lockNotifs(); notifsHost.replaceChildren(n || el('div', { style: { height: '4px' } })); };
    renderN();
    const a = State.events.on('notif', renderN);
    const b = State.events.on('notif-change', renderN);
    offNotif = () => { a(); b(); };
  }

  const status = el('div', { class: 'lock-status' }, el('span', { html: icon('lock') }),
    el('span', { text: isPass ? 'Encrypted · enter passphrase' : 'Encrypted · enter PIN to decrypt' }));
  const hint = el('div', { class: 'lock-hint', text: '' });
  const inputArea = el('div', { class: 'lock-input' });

  // --- lockout countdown ------------------------------------------------
  let lockUntil = pub.lockUntil || 0;
  let cdTimer = null;
  const setDisabled = (on) => { inputArea.classList.toggle('disabled', on); };
  const stopCountdown = () => { clearInterval(cdTimer); cdTimer = null; };
  const startCountdown = () => {
    stopCountdown(); setDisabled(true);
    const step = () => {
      const rem = Math.ceil((lockUntil - Date.now()) / 1000);
      if (rem <= 0) { stopCountdown(); setDisabled(false); hint.textContent = ''; return; }
      hint.textContent = `Too many attempts · try again in ${fmtDur(rem)}`;
    };
    step(); cdTimer = setInterval(step, 1000);
  };

  layer._cleanup = () => { clearInterval(tick); offNotif(); stopCountdown(); };

  // --- PIN vs passphrase input -----------------------------------------
  let field = null, dotsWrap = null;
  const renderDots = () => dotsWrap && dotsWrap.replaceChildren(dotsRow(pin.length));
  const getSecret = () => (isPass ? (field?.value || '') : pin);
  const clearSecret = () => { pin = ''; if (field) field.value = ''; renderDots(); };

  const shakeErr = (msg) => {
    if (dotsWrap) { const dr = dotsWrap.querySelector('.pin-dots'); if (dr) dr.classList.add('err'); }
    if (field) field.classList.add('err');
    haptic(40); hint.textContent = msg;
    setTimeout(() => { clearSecret(); if (field) field.classList.remove('err'); if (!cdTimer) hint.textContent = ''; }, 500);
  };

  let busy = false;
  const submit = async () => {
    if (busy || cdTimer) return;
    const secret = getSecret();
    const min = isPass ? 1 : 4;
    if (secret.length < min) { if (secret.length) shakeErr(isPass ? 'Enter your passphrase' : 'Too short'); return; }
    busy = true; hint.textContent = 'Decrypting…';
    const res = await verifyPin(profileId, secret);
    busy = false;
    if (res.status === 'ok') { layer._cleanup(); onUnlock(res.key, res.vault); return; }
    if (res.status === 'duress') { layer._cleanup(); onDuress(); return; }
    if (res.status === 'wipe') { layer._cleanup(); (onWipe || onDuress)(); return; }
    if (res.status === 'throttled') { lockUntil = res.until; clearSecret(); startCountdown(); return; }
    // plain fail
    const label = isPass ? 'passphrase' : 'PIN';
    const msg = res.remaining != null ? `Wrong ${label} · ${res.remaining} left before wipe` : `Wrong ${label}`;
    shakeErr(msg);
    if (res.until && res.until > Date.now()) { lockUntil = res.until; startCountdown(); }
  };

  if (isPass) {
    field = el('input', { class: 'field lock-pass', attrs: { type: 'password', placeholder: 'Passphrase', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' } });
    field.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    inputArea.append(field, el('div', { style: { marginTop: '12px', maxWidth: '300px', margin: '12px auto 0' } }, bigButton('Unlock', { kind: 'primary', icon: 'unlock', onClick: submit })));
  } else {
    dotsWrap = el('div', {});
    renderDots();
    inputArea.append(dotsWrap, keypad({
      scramble,
      onDigit: (d) => { if (pin.length < 16) { pin += d; renderDots(); } },
      onBack: () => { pin = pin.slice(0, -1); renderDots(); },
      onSubmit: submit,
    }));
  }

  layer.append(
    el('div', { style: { textAlign: 'center', paddingTop: '20px' } }, clock, date, status),
    notifsHost,
    el('div', { class: 'lock-spacer' }),
    inputArea,
    hint,
  );

  if (lockUntil > Date.now()) startCountdown();
  else if (isPass) setTimeout(() => field && field.focus(), 80);
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
