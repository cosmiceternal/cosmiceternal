// NyxOS entry point: boot splash → integrity check → shell.
import { el, sleep } from './core/util.js';
import { icon } from './core/icons.js';
import { State } from './core/state.js';
import { verifyBoot } from './core/integrity.js';
import { applyTheme } from './shell/theme-apply.js';
import { Shell } from './shell/shell.js';
import './apps/index.js';

async function boot() {
  const screen = document.getElementById('screen');

  const integLine = el('div', { class: 'boot-integrity', html: icon('shield') + '<span>Verifying boot…</span>' });
  const splash = el('div', { class: 'boot' },
    el('div', { class: 'boot-inner' },
      el('div', { class: 'boot-logo', html: icon('moon') }),
      el('h1', { text: 'NyxOS' }),
      el('div', { class: 'boot-tag', text: 'Privacy-first phone OS' }),
      el('div', { class: 'boot-bar' }, el('span', {})),
      integLine,
    ));
  screen.appendChild(splash);

  // Device config must load before anything (profiles, integrity baseline).
  State.init();
  applyTheme();

  // Verified-boot analog.
  const started = Date.now();
  let integrity;
  try { integrity = await verifyBoot(); } catch (e) { integrity = { mode: 'unknown', ok: true, error: String(e) }; }
  State.integrity = integrity;

  const setLine = (cls, text) => { integLine.className = 'boot-integrity ' + cls; integLine.querySelector('span').textContent = text; };
  if (integrity.ok) setLine('ok', integrity.mode === 'signed' ? 'Boot verified' : integrity.first ? 'Baseline recorded' : 'Boot verified');
  else setLine('bad', 'Integrity warning');

  // Register the offline service worker (best-effort; needs a secure context).
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // Let the splash breathe briefly.
  await sleep(Math.max(0, 700 - (Date.now() - started)));

  Shell.init();
  Shell.decideEntry();

  // If integrity failed, block with a prominent, non-dismissible warning —
  // on real hardware verified boot would refuse to start.
  if (!integrity.ok) {
    const { modal } = await import('./shell/ui.js');
    const detail = integrity.mode === 'signed'
      ? `${integrity.mismatches?.length || 0} core file(s) failed verification${integrity.mismatches?.length ? ': ' + integrity.mismatches.slice(0, 6).join(', ') : ''}.`
      : 'Core files changed since the first boot on this device.';
    modal({
      title: '⚠ Boot integrity failed',
      body: `NyxOS could not verify its own code. ${detail} On a real device, verified boot would refuse to start. Only continue if you intentionally edited the source — then run “npm run integrity” to re-sign.`,
      actions: [{ label: 'Continue anyway', kind: 'danger', value: 1 }],
      dismissable: false,
    });
  }

  splash.style.transition = 'opacity .35s';
  splash.style.opacity = '0';
  setTimeout(() => splash.remove(), 400);
}

boot();
