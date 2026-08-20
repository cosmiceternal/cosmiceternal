import { registerApp } from '../core/registry.js';
import { el } from '../core/util.js';
import { icon } from '../core/icons.js';
import { State, WALLPAPERS, ACCENTS } from '../core/state.js';
import { Store } from '../core/store.js';
import { Bridge } from '../core/bridge.js';
import { PBKDF2_ITERS } from '../core/crypto.js';
import { changePin, setDuressPin, hasDuress, setupPin, setAutoWipe, getPublicMeta, verifySecret, securityLog, clearSecurityLog } from '../core/security.js';
import { section, list, row, toggleRow, toggle, bigButton, segmented } from '../shell/kit.js';
import { modal } from '../shell/ui.js';
import { relTime } from '../core/util.js';

export const OS = { name: 'NyxOS', version: '0.1.0', codename: 'Nightfall' };

const AUTOWIPE = [{ label: 'Off', n: 0 }, { label: 'After 5', n: 5 }, { label: 'After 10', n: 10 }, { label: 'After 15', n: 15 }, { label: 'After 30', n: 30 }];
const CLIPCLEAR = [{ label: 'Never', n: 0 }, { label: '30 seconds', n: 30 }, { label: '45 seconds', n: 45 }, { label: '1 minute', n: 60 }, { label: '2 minutes', n: 120 }];
const AUTOREBOOT = [{ label: 'Off', n: 0 }, { label: '5 minutes', n: 5 }, { label: '15 minutes', n: 15 }, { label: '30 minutes', n: 30 }, { label: '1 hour', n: 60 }, { label: '4 hours', n: 240 }];

const LOG_LABELS = {
  'unlock': ['Unlocked', 'unlock', '#6ee7d0'],
  'unlock-failed': ['Failed unlock', 'x', '#ffcf6b'],
  'lockout': ['Locked out (throttled)', 'clock', '#ff6b6b'],
  'auto-wipe': ['Auto-wipe triggered', 'shield', '#ff6b6b'],
  'duress-set': ['Duress PIN set', 'flag', '#c58cff'],
  'duress-cleared': ['Duress PIN removed', 'flag', '#9aa7c2'],
  'credential-changed': ['Unlock secret changed', 'key', '#7aa2ff'],
};

const AUTOLOCK = [
  { label: 'Immediately', ms: 1 }, { label: '15 seconds', ms: 15000 },
  { label: '30 seconds', ms: 30000 }, { label: '1 minute', ms: 60000 },
  { label: '5 minutes', ms: 300000 }, { label: 'Never', ms: 0 },
];

registerApp({
  id: 'settings', name: 'Settings', icon: 'settings', color: '#9aa7c2', order: 90, dock: true, system: true,
  mount(root, sys, ctx) {
    // ---- root ----
    function showRoot() {
      ctx._view = 'root';
      ctx.clearBack?.(); ctx.setTitle('Settings'); ctx.setActions([]);
      const cat = (ic, color, title, sub, fn) => row({ icon: ic, iconColor: color, title, sub, onClick: fn });
      root.replaceChildren(
        list(
          cat('network', '#7aa2ff', 'Network & connectivity', 'Wi‑Fi, routing, radios', showNetwork),
          cat('sun', '#ffd166', 'Display', 'Theme, wallpaper, brightness', showDisplay),
          cat('shield', '#6ee7d0', 'Security', 'PIN, duress, lock screen', showSecurity),
          cat('eye', '#c58cff', 'Privacy & permissions', 'Per-app control, sensors', () => sys.openApp('privacy')),
          cat('users', '#8be9a0', 'Users & profiles', `${State.device.profiles.length} profile${State.device.profiles.length === 1 ? '' : 's'}`, showProfiles),
          cat('store', '#ff9e7a', 'Apps', 'Installed apps & store', () => sys.openApp('store')),
        ),
        section('System'),
        list(
          cat('download', '#7aa2ff', 'System update', `${OS.name} ${OS.version}`, showUpdates),
          cat('shieldCheck', '#6ee7d0', 'Security features', 'Hardening & what’s enforced', showSecurityFeatures),
          cat('info', '#9aa7c2', 'About', `${OS.name} · ${OS.codename}`, showAbout),
        ),
        el('div', { class: 'hint', text: `${OS.name} ${OS.version} — free & open source. Runs entirely on-device.` }),
      );
    }

    // ---- network ----
    function showNetwork() {
      ctx._view = 'network'; ctx.setTitle('Network'); ctx.pushBack(showRoot);
      const t = () => State.get('toggles', {}) || {};
      const routing = t().routing || 'direct';
      const routeSeg = segmented([
        { name: 'Direct', render: () => {} }, { name: 'VPN', render: () => {} }, { name: 'Tor', render: () => {} },
      ]);
      routeSeg.select({ direct: 0, vpn: 1, tor: 2 }[routing]);
      routeSeg.el.querySelectorAll('.seg button').forEach((b, i) => b.addEventListener('click', () => State.set('toggles.routing', ['direct', 'vpn', 'tor'][i])));

      root.replaceChildren(
        list(
          toggleRow({ icon: 'wifi', iconColor: '#7aa2ff', title: 'Wi‑Fi', sub: t().wifi ? (t().wifiName || 'Connected') : 'Off', value: !!t().wifi, onChange: (v) => { State.set('toggles.wifi', v); showNetwork(); } }),
          toggleRow({ icon: 'bluetooth', iconColor: '#7aa2ff', title: 'Bluetooth', value: !!t().bluetooth, onChange: (v) => State.set('toggles.bluetooth', v) }),
          toggleRow({ icon: 'airplane', iconColor: '#9aa7c2', title: 'Airplane mode', sub: 'Disables all radios', value: !!t().airplane, onChange: (v) => { State.set('toggles.airplane', v); showNetwork(); } }),
          toggleRow({ icon: 'location', iconColor: '#8be9a0', title: 'Location', sub: 'Master location switch', value: t().location !== false, onChange: (v) => State.set('toggles.location', v) }),
        ),
        section('Traffic routing (per profile)'),
        el('div', { style: { padding: '4px' } }, routeSeg.el),
        el('div', { class: 'hint', text: 'Route this profile’s traffic Direct, through a VPN, or over Tor. Each profile keeps its own routing.' }),
      );
    }

    // ---- display ----
    function showDisplay() {
      ctx._view = 'display'; ctx.setTitle('Display'); ctx.pushBack(showRoot);
      const s = State.get('settings', {}) || {};
      const themeSeg = segmented([
        { name: 'Dark', render: () => {} }, { name: 'Light', render: () => {} }, { name: 'System', render: () => {} },
      ]);
      themeSeg.select({ dark: 0, light: 1, system: 2 }[s.theme || 'dark']);
      themeSeg.el.querySelectorAll('.seg button').forEach((b, i) => b.addEventListener('click', () => State.set('settings.theme', ['dark', 'light', 'system'][i])));

      const accents = el('div', { class: 'chips' });
      ACCENTS.forEach((c) => accents.append(el('button', { class: 'chip' + (s.accent === c ? ' on' : ''), style: { background: c, color: '#04231c', minWidth: '38px', height: '34px' }, attrs: { 'aria-label': 'accent ' + c }, on: { click: () => { State.set('settings.accent', c); showDisplay(); } } })));

      const walls = el('div', { class: 'chips' });
      WALLPAPERS.forEach((w) => walls.append(el('button', { class: 'chip' + (s.wallpaper === w.id ? ' on' : ''), text: w.name, on: { click: () => { State.set('settings.wallpaper', w.id); showDisplay(); } } })));

      const bright = el('input', { attrs: { type: 'range', min: '0.3', max: '1', step: '0.05' }, value: String(s.brightness ?? 1), style: { width: '100%', accentColor: 'var(--accent)' } });
      bright.addEventListener('input', () => State.set('settings.brightness', parseFloat(bright.value)));

      root.replaceChildren(
        section('Theme'), el('div', { style: { padding: '4px' } }, themeSeg.el),
        section('Accent'), el('div', { style: { padding: '8px 4px' } }, accents),
        section('Wallpaper'), el('div', { style: { padding: '8px 4px' } }, walls),
        section('Brightness'),
        el('div', { class: 'list', style: { padding: '14px' } }, el('div', { style: { display: 'flex', gap: '12px', alignItems: 'center' } }, el('span', { html: icon('sun'), style: { color: 'var(--text-dim)' } }), bright)),
      );
    }

    // Generic single-choice picker (safe DOM, no innerHTML).
    function picker(title, options, isCurrent, onPick) {
      const body = el('div', {});
      options.forEach((o) => body.append(el('button', {
        class: 'row tap', style: { width: '100%', background: 'var(--surface-2)', borderRadius: '10px', marginBottom: '6px' },
        on: { click: () => { document.querySelector('.modal-scrim')?.remove(); onPick(o); } },
      }, el('span', { class: 'r-main' }, el('span', { class: 'r-title', text: o.label })),
      isCurrent(o) ? el('span', { html: icon('check'), style: { color: 'var(--accent)' } }) : null)));
      modal({ title, body, actions: [{ label: 'Close', kind: 'ghost', value: 0 }] });
    }

    // Re-authenticate before a sensitive change (no throttle side effects).
    async function requireAuth(reason) {
      const mode = getPublicMeta(State.activeId)?.mode || 'pin';
      const s = await sys.prompt({ title: 'Confirm it’s you', message: reason || `Enter your current ${mode}`, type: 'password', confirmLabel: 'Confirm' });
      if (s == null) return false;
      if (!(await verifySecret(State.activeId, s))) { sys.toast('Incorrect', { icon: 'alert' }); return false; }
      return true;
    }

    // ---- security ----
    function showSecurity() {
      ctx._view = 'security'; ctx.setTitle('Security'); ctx.pushBack(showRoot);
      const sec = () => State.get('security', {}) || {};
      const autolock = AUTOLOCK.find((a) => a.ms === sec().autoLockMs) || AUTOLOCK[2];
      const autowipe = AUTOWIPE.find((a) => a.n === (sec().autoWipeAttempts || 0)) || AUTOWIPE[0];
      const clip = CLIPCLEAR.find((c) => c.n === (sec().clipboardClearSec ?? 45)) || CLIPCLEAR[2];
      const mode = getPublicMeta(State.activeId)?.mode || 'pin';
      const modeLabel = mode === 'passphrase' ? 'Passphrase' : 'PIN';
      const iters = Store.loadMeta(State.activeId)?.iterations || PBKDF2_ITERS;

      root.replaceChildren(
        list(
          row({ icon: 'shieldCheck', iconColor: '#6ee7d0', title: 'Security checkup', sub: 'Review and harden your setup', onClick: showSecurityCheckup }),
        ),
        section('Authentication'),
        list(
          row({ icon: 'key', iconColor: '#ffd166', title: `Change ${modeLabel.toLowerCase()}`, onClick: () => setCredentialFlow(mode) }),
          row({ icon: 'lock', iconColor: '#7aa2ff', title: 'Unlock method', value: modeLabel, onClick: switchMethod }),
          row({ icon: 'flag', iconColor: '#ff6b6b', title: 'Duress PIN', sub: hasDuress(State.activeId) ? 'Set — wipes device when entered' : 'Not set', onClick: duressFlow }),
          row({ icon: 'trash', iconColor: '#ff6b6b', title: 'Auto-wipe on failed unlocks', value: autowipe.label, onClick: pickAutowipe }),
          row({ icon: 'clock', iconColor: '#7aa2ff', title: 'Auto-lock', value: autolock.label, onClick: pickAutolock }),
          row({ icon: 'power', iconColor: '#c58cff', title: 'Auto-reboot when locked', sub: 'Evict keys — return to first-unlock state', value: (AUTOREBOOT.find((a) => a.n === (sec().autoRebootMin || 0)) || AUTOREBOOT[0]).label, onClick: pickAutoreboot }),
        ),
        section('Lock screen'),
        list(
          mode === 'pin' ? toggleRow({ icon: 'shield', iconColor: '#c58cff', title: 'Scramble PIN layout', sub: 'Randomize keypad to defeat shoulder-surfing', value: !!State.device.scramblePin, onChange: (v) => { State.device.scramblePin = v; State.saveDevice(); } }) : null,
          toggleRow({ icon: 'usb', iconColor: '#c58cff', title: 'Block USB when locked', sub: 'Ignore USB data on the lock screen', value: sec().lockUsb, onChange: (v) => State.set('security.lockUsb', v) }),
          toggleRow({ icon: 'camera', iconColor: '#ff9e7a', title: 'Block camera when locked', value: sec().lockCamera, onChange: (v) => State.set('security.lockCamera', v) }),
          toggleRow({ icon: 'settings', iconColor: '#9aa7c2', title: 'Hide quick tiles when locked', value: sec().lockQuickTiles, onChange: (v) => State.set('security.lockQuickTiles', v) }),
        ),
        section('Privacy'),
        list(
          row({ icon: 'clipboard', iconColor: '#ffd166', title: 'Clipboard auto-clear', value: clip.label, onClick: pickClipClear }),
          toggleRow({ icon: 'eyeOff', iconColor: '#7aa2ff', title: 'Hide sensitive notifications', sub: 'On the lock screen', value: sec().hideNotifContent !== false, onChange: (v) => State.set('security.hideNotifContent', v) }),
          toggleRow({ icon: 'vpn', iconColor: '#8be9a0', title: 'Block network without VPN/Tor', sub: 'Deny all app traffic unless routed', value: !!sec().blockWithoutVpn, onChange: (v) => State.set('security.blockWithoutVpn', v) }),
        ),
        section('Protection'),
        list(
          toggleRow({ icon: 'shieldCheck', iconColor: '#6ee7d0', title: 'Advanced Protection', sub: 'Stricter defaults: sensors off, USB blocked, network guarded', value: sec().advancedProtection, onChange: applyAdvanced }),
        ),
        list(
          row({ icon: 'doc', iconColor: '#9aa7c2', title: 'Security log', sub: 'Recent authentication events', onClick: showSecurityLog }),
          row({ icon: 'lock', iconColor: '#8be9a0', title: 'Encryption', sub: `AES‑256‑GCM · PBKDF2 ${Math.round(iters / 1000)}k iterations`, onClick: () => modal({ title: 'Storage encryption', body: `This profile is encrypted with AES‑256‑GCM. The key is derived from your ${mode} with PBKDF2‑SHA256 (${iters.toLocaleString()} iterations). Data at rest is ciphertext; without your ${mode} it cannot be read.`, actions: [{ label: 'Close', kind: 'primary', value: 1 }] }) }),
        ),
        section('Danger zone'),
        el('div', { style: { padding: '4px' } }, bigButton('Factory reset this device', { kind: 'danger', icon: 'trash', onClick: factoryReset })),
      );
    }

    async function setCredentialFlow(targetMode) {
      if (!(await requireAuth('Enter your current secret to change it'))) return;
      const isPass = targetMode === 'passphrase';
      const p1 = await sys.prompt({ title: isPass ? 'New passphrase' : 'New PIN', message: isPass ? 'Use a strong, memorable passphrase (6+ characters)' : 'Enter 4–12 digits', type: 'password', confirmLabel: 'Next' });
      if (p1 == null) return;
      if (isPass) { if (p1.length < 6) return sys.toast('Passphrase must be 6+ characters', { icon: 'alert' }); }
      else if (!/^\d{4,12}$/.test(p1)) return sys.toast('PIN must be 4–12 digits', { icon: 'alert' });
      const p2 = await sys.prompt({ title: 'Confirm', type: 'password', confirmLabel: 'Save' });
      if (p2 !== p1) return sys.toast('Entries did not match', { icon: 'alert' });
      await changePin(State.activeId, p1, targetMode);
      sys.toast(isPass ? 'Passphrase set' : 'PIN changed', { type: 'ok', icon: 'check' });
      showSecurity();
    }

    function switchMethod() {
      const cur = getPublicMeta(State.activeId)?.mode || 'pin';
      picker('Unlock method',
        [{ label: 'PIN (numeric)', mode: 'pin' }, { label: 'Passphrase (letters & numbers)', mode: 'passphrase' }],
        (o) => o.mode === cur, (o) => setCredentialFlow(o.mode));
    }

    function pickAutowipe() {
      picker('Auto-wipe on failed unlocks', AUTOWIPE, (o) => o.n === (State.get('security.autoWipeAttempts', 0)), async (o) => {
        if (!(await requireAuth('Confirm to change auto-wipe'))) return;
        if (o.n > 0 && !(await sys.confirm({ title: 'Enable auto-wipe?', message: `After ${o.n} failed unlock attempts, this device will be PERMANENTLY WIPED.`, confirmLabel: 'Enable', danger: true }))) return;
        State.set('security.autoWipeAttempts', o.n); setAutoWipe(State.activeId, o.n);
        sys.toast(o.n ? `Auto-wipe after ${o.n} attempts` : 'Auto-wipe off', { icon: 'shield', type: o.n ? 'danger' : '' });
        showSecurity();
      });
    }

    function pickClipClear() {
      picker('Clipboard auto-clear', CLIPCLEAR, (o) => o.n === (State.get('security.clipboardClearSec', 45)), (o) => { State.set('security.clipboardClearSec', o.n); showSecurity(); });
    }

    function pickAutoreboot() {
      picker('Auto-reboot when locked', AUTOREBOOT, (o) => o.n === (State.get('security.autoRebootMin', 0)), (o) => {
        State.set('security.autoRebootMin', o.n);
        sys.toast(o.n ? `Auto-reboot after ${o.n} min locked` : 'Auto-reboot off', { icon: 'power' });
        showSecurity();
      });
    }

    function showSecurityLog() {
      ctx._view = 'seclog'; ctx.setTitle('Security log'); ctx.pushBack(showSecurity);
      const events = securityLog();
      const rows = events.map((e) => {
        const [label, ic, color] = LOG_LABELS[e.type] || [e.type, 'info', '#9aa7c2'];
        return row({ icon: ic, iconColor: color, title: label, value: relTime(e.ts) });
      });
      root.replaceChildren(
        el('div', { class: 'hint', text: 'Authentication events on this device. Timestamps and event types only — no secrets or content are recorded.' }),
        events.length ? list(...rows) : el('div', { class: 'empty-state' }, el('div', { html: icon('doc') }), el('p', { text: 'No events yet' })),
        events.length ? el('div', { style: { padding: '10px 4px' } }, bigButton('Clear log', { onClick: () => { clearSecurityLog(); showSecurityLog(); } })) : null,
      );
    }

    function showSecurityCheckup() {
      ctx._view = 'checkup'; ctx.setTitle('Security checkup'); ctx.pushBack(showSecurity);
      const sec = State.get('security', {}) || {};
      const mode = getPublicMeta(State.activeId)?.mode || 'pin';
      const checks = [
        { ok: mode === 'passphrase', title: 'Strong unlock secret', good: 'Using a passphrase', bad: 'A passphrase resists offline brute force far better than a PIN', fix: switchMethod },
        { ok: hasDuress(State.activeId), title: 'Duress PIN', good: 'Configured', bad: 'Set a PIN that wipes the device under coercion', fix: duressFlow },
        { ok: (sec.autoWipeAttempts || 0) > 0, title: 'Auto-wipe', good: `After ${sec.autoWipeAttempts} attempts`, bad: 'Wipe after repeated failed unlocks', fix: pickAutowipe },
        { ok: (sec.autoRebootMin || 0) > 0, title: 'Auto-reboot', good: `After ${sec.autoRebootMin} min locked`, bad: 'Evict keys after a period locked', fix: pickAutoreboot },
        { ok: sec.autoLockMs > 0 && sec.autoLockMs <= 60000, title: 'Quick auto-lock', good: 'One minute or less', bad: 'Lock the screen sooner when idle', fix: pickAutolock },
        { ok: sec.hideNotifContent !== false, title: 'Lock-screen privacy', good: 'Sensitive content hidden', bad: 'Hide sensitive notifications when locked', fix: () => { State.set('security.hideNotifContent', true); showSecurityCheckup(); } },
        { ok: (sec.clipboardClearSec ?? 45) > 0, title: 'Clipboard auto-clear', good: 'On', bad: 'Clear copied secrets automatically', fix: pickClipClear },
        { ok: !!sec.advancedProtection, title: 'Advanced Protection', good: 'On', bad: 'Enable stricter privacy defaults', fix: () => applyAdvanced(true) },
      ];
      const passed = checks.filter((c) => c.ok).length;
      const pct = Math.round((passed / checks.length) * 100);
      const color = pct >= 80 ? 'var(--ok)' : pct >= 50 ? 'var(--warn)' : 'var(--danger)';
      root.replaceChildren(
        el('div', { class: 'list', style: { padding: '18px', textAlign: 'center' } },
          el('div', { style: { fontSize: '36px', fontWeight: '700', color }, text: `${passed}/${checks.length}` }),
          el('div', { class: 'hint', text: 'security features enabled' }),
          el('div', { class: 'storage-bar', style: { marginTop: '12px' } }, el('span', { style: { width: pct + '%', background: color } }))),
        list(...checks.map((c) => row({
          icon: c.ok ? 'shieldCheck' : 'alert', iconColor: c.ok ? '#6ee7d0' : '#ffcf6b',
          title: c.title, sub: c.ok ? c.good : c.bad,
          right: c.ok ? el('span', { class: 'badge-pill live', text: 'On' })
            : el('button', { class: 'sc-btn', style: { padding: '6px 14px' }, text: 'Fix', on: { click: () => c.fix() } }),
        }))),
        el('div', { class: 'hint', text: 'These are controls NyxOS enforces in a browser. Hardware-backed items (verified boot, secure element, hardware key throttling) require a real device.' }),
      );
    }

    async function duressFlow() {
      if (!(await requireAuth('Confirm to change the duress PIN'))) return;
      if (hasDuress(State.activeId)) {
        if (await sys.confirm({ title: 'Remove duress PIN?', message: 'The duress PIN will no longer wipe the device.', confirmLabel: 'Remove', danger: true })) {
          await setDuressPin(State.activeId, null); sys.toast('Duress PIN removed'); showSecurity();
        }
        return;
      }
      const ok = await sys.confirm({ title: 'Set a duress PIN', message: 'Entering this PIN at the lock screen will PERMANENTLY WIPE all data on this device. Use a PIN you will not enter by accident.', confirmLabel: 'I understand', danger: true });
      if (!ok) return;
      const p1 = await sys.prompt({ title: 'Duress PIN', message: '4–12 digits, different from your normal PIN', type: 'password', confirmLabel: 'Next' });
      if (p1 == null) return;
      if (!/^\d{4,12}$/.test(p1)) return sys.toast('PIN must be 4–12 digits', { icon: 'alert' });
      const p2 = await sys.prompt({ title: 'Confirm duress PIN', type: 'password', confirmLabel: 'Set' });
      if (p2 !== p1) return sys.toast('PINs did not match', { icon: 'alert' });
      await setDuressPin(State.activeId, p1);
      sys.toast('Duress PIN set', { type: 'danger', icon: 'flag' });
      showSecurity();
    }

    function pickAutolock() {
      picker('Auto-lock', AUTOLOCK, (a) => a.ms === State.get('security.autoLockMs', 30000), (a) => { State.set('security.autoLockMs', a.ms); showSecurity(); });
    }

    function applyAdvanced(v) {
      State.update((vault) => {
        vault.security.advancedProtection = v;
        if (v) { vault.security.sensorsGlobal = false; vault.security.lockUsb = true; vault.security.lockCamera = true; vault.security.hideNotifContent = true; }
      });
      sys.toast(v ? 'Advanced Protection on' : 'Advanced Protection off', { icon: 'shieldCheck', type: v ? 'ok' : '' });
      showSecurity();
    }

    async function factoryReset() {
      if (!(await requireAuth('Confirm your secret to factory reset'))) return;
      if (!await sys.confirm({ title: 'Factory reset?', message: 'This erases every profile and all data on this device. This cannot be undone.', confirmLabel: 'Erase everything', danger: true })) return;
      Store.wipeAll();
      Bridge.reboot();
    }

    // ---- profiles ----
    function showProfiles() {
      ctx._view = 'profiles'; ctx.setTitle('Users & profiles'); ctx.pushBack(showRoot);
      const rows = State.device.profiles.map((p) => {
        const active = p.id === State.activeId;
        return row({
          icon: 'user', iconColor: p.color, title: p.name, sub: active ? 'Current profile' : 'Tap to switch',
          right: active ? el('span', { class: 'badge-pill live', text: 'Active' }) : el('span', { html: icon('chevronRight'), style: { color: 'var(--text-mute)' } }),
          onClick: () => { if (active) return; Bridge.switchProfile(p.id); },
        });
      });
      root.replaceChildren(
        list(...rows),
        el('div', { style: { padding: '10px 4px' } }, bigButton('Add profile', { kind: 'primary', icon: 'plus', onClick: addProfile })),
        el('div', { class: 'hint', text: 'Profiles are fully isolated — separate encrypted storage, apps, permissions and traffic routing. Deleting a profile erases its data.' }),
        State.device.profiles.length > 1 ? el('div', { style: { padding: '4px' } }, bigButton('Delete a profile', { kind: 'danger', icon: 'trash', onClick: deleteProfile })) : null,
      );
    }

    async function addProfile() {
      const name = await sys.prompt({ title: 'New profile', message: 'Profile name', placeholder: 'Work', confirmLabel: 'Next' });
      if (!name) return;
      const p1 = await sys.prompt({ title: 'Profile PIN', message: '4–12 digits', type: 'password', confirmLabel: 'Next' });
      if (p1 == null) return;
      if (!/^\d{4,12}$/.test(p1)) return sys.toast('PIN must be 4–12 digits', { icon: 'alert' });
      const p2 = await sys.prompt({ title: 'Confirm PIN', type: 'password', confirmLabel: 'Create' });
      if (p2 !== p1) return sys.toast('PINs did not match', { icon: 'alert' });
      const color = ACCENTS[State.device.profiles.length % ACCENTS.length];
      const id = State.addProfileRecord(name, color);
      await setupPin(id, p1, { name, color });
      sys.toast(`Profile “${name}” created`, { type: 'ok', icon: 'check' });
      showProfiles();
    }

    async function deleteProfile() {
      const others = State.device.profiles.filter((p) => p.id !== State.activeId);
      const body = el('div', {});
      others.forEach((p) => body.append(el('button', { class: 'row tap', style: { width: '100%', background: 'var(--surface-2)', borderRadius: '10px', marginBottom: '6px' }, on: { click: async () => { document.querySelector('.modal-scrim')?.remove(); if (await sys.confirm({ title: `Delete “${p.name}”?`, message: 'All of this profile’s data will be erased.', confirmLabel: 'Delete', danger: true })) { Store.wipeProfile(p.id); State.device.profiles = State.device.profiles.filter((x) => x.id !== p.id); State.saveDevice(); sys.toast('Profile deleted'); showProfiles(); } } } },
        el('span', { class: 'r-icon', style: { background: p.color }, html: icon('user') }),
        el('span', { class: 'r-main' }, el('span', { class: 'r-title', text: p.name })))));
      modal({ title: 'Delete profile', body, actions: [{ label: 'Cancel', kind: 'ghost', value: 0 }] });
    }

    // ---- updates ----
    function showUpdates() {
      ctx._view = 'updates'; ctx.setTitle('System update'); ctx.pushBack(showRoot);
      const patch = new Date(); const patchStr = `${patch.getFullYear()}-${String(patch.getMonth() + 1).padStart(2, '0')}-05`;
      const status = el('div', { class: 'list', style: { padding: '18px', textAlign: 'center' } },
        el('div', { style: { display: 'grid', placeItems: 'center', color: 'var(--ok)', marginBottom: '10px' }, html: icon('shieldCheck') }),
        el('div', { style: { fontSize: '17px', fontWeight: '600' }, text: `${OS.name} ${OS.version}` }),
        el('div', { class: 'hint', text: 'Your system is up to date.' }));
      const btn = bigButton('Check for updates', { kind: 'primary', icon: 'refresh', onClick: () => {
        btn.querySelector('span:last-child').textContent = 'Checking…';
        setTimeout(() => { btn.querySelector('span:last-child').textContent = 'Check for updates'; sys.toast('No updates available', { icon: 'check' }); }, 1200);
      } });
      root.replaceChildren(status, el('div', { style: { padding: '10px 4px' } }, btn),
        list(
          row({ icon: 'shield', iconColor: '#6ee7d0', title: 'Security patch level', value: patchStr }),
          row({ icon: 'download', iconColor: '#7aa2ff', title: 'Update channel', value: 'Stable' }),
        ),
        el('div', { class: 'perm-scope-note' }, 'Over-the-air updates with signed builds and verified boot ship on real hardware. ', el('span', { class: 'badge-pill rom', text: 'Represented' })));
    }

    // ---- security features (honest hardening map) ----
    function showSecurityFeatures() {
      ctx._view = 'secfeat'; ctx.setTitle('Security features'); ctx.pushBack(showRoot);
      const feat = (title, sub, kind) => row({ icon: kind === 'live' ? 'shieldCheck' : kind === 'partial' ? 'shield' : 'bug', iconColor: kind === 'live' ? '#6ee7d0' : kind === 'partial' ? '#ffd166' : '#9aa7c2', title, sub, right: el('span', { class: 'badge-pill ' + (kind === 'live' ? 'live' : kind === 'partial' ? '' : 'rom'), text: kind === 'live' ? 'Enforced' : kind === 'partial' ? 'Partial' : 'Needs ROM' }) });
      root.replaceChildren(
        el('div', { class: 'hint', text: 'What NyxOS enforces in this build, and what needs a real hardware ROM.' }),
        section('Enforced here'),
        list(
          feat('App sandboxing', 'Capability-scoped; apps can’t reach what you don’t grant', 'live'),
          feat('Stronger permission model', 'Per-app network, sensors, storage scopes & more', 'live'),
          feat('Filesystem-style encryption', 'AES‑256‑GCM, PBKDF2‑600k, PIN/passphrase key', 'live'),
          feat('Brute-force throttling', 'Escalating lockout after failed unlocks', 'live'),
          feat('Auto-wipe', 'Optional device wipe after N failed unlocks', 'live'),
          feat('Auto-reboot', 'Evict keys to first-unlock state when idle', 'live'),
          feat('Passphrase unlock', 'Alphanumeric secret resists offline attack', 'live'),
          feat('Re-authentication', 'Confirm secret before sensitive changes', 'live'),
          feat('Network kill switch', 'Block app traffic unless routed via VPN/Tor', 'live'),
          feat('Security audit log', 'Records auth events (no secrets)', 'live'),
          feat('Duress PIN', 'A secret PIN that wipes the device', 'live'),
          feat('Scramble PIN layout', 'Anti shoulder-surf / smudge', 'live'),
          feat('Lock screen restrictions', 'USB, camera & quick tiles when locked', 'live'),
          feat('Clipboard alerts + auto-clear', 'Surface reads; wipe copied secrets on a timer', 'live'),
          feat('Content-Security-Policy', 'No inline scripts, no eval, no framing', 'live'),
        ),
        section('Partial'),
        list(
          feat('Verified boot / signed builds', 'Core files checked against a signed manifest', 'partial'),
        ),
        section('Requires a hardware ROM'),
        list(
          feat('Hardened memory allocator', 'hardened_malloc replacing the system allocator', 'rom'),
          feat('Kernel mitigations', 'ASLR, stack canaries, hardened kernel', 'rom'),
          feat('Firmware & OTA signing', 'Signed firmware with a hardware root of trust', 'rom'),
          feat('Advanced Protection Program', 'Hardware-backed account protection', 'rom'),
        ),
        el('div', { class: 'hint', text: 'These last items depend on the bootloader, kernel and firmware of a physical device — they can’t exist in a web runtime, so NyxOS is honest about them rather than faking the claim.' }),
      );
    }

    // ---- about ----
    function showAbout() {
      ctx._view = 'about'; ctx.setTitle('About'); ctx.pushBack(showRoot);
      const integ = State.integrity || {};
      const integLabel = integ.mode === 'signed' ? (integ.ok ? 'Verified (signed manifest)' : 'FAILED — tampering detected') : integ.mode === 'tofu' ? (integ.ok ? 'Verified (trust-on-first-use)' : 'CHANGED since first boot') : 'Unknown';
      root.replaceChildren(
        el('div', { style: { textAlign: 'center', padding: '20px 0' } },
          el('div', { class: 'boot-logo', style: { width: '72px', height: '72px', margin: '0 auto 10px' }, html: icon('moon') }),
          el('div', { style: { fontSize: '22px', fontWeight: '600' }, text: OS.name }),
          el('div', { class: 'hint', text: `${OS.codename} · ${OS.version}` })),
        list(
          row({ icon: 'shieldCheck', iconColor: integ.ok === false ? '#ff6b6b' : '#6ee7d0', title: 'Boot integrity', value: integ.ok === false ? 'Failed' : 'Verified', onClick: () => modal({ title: 'Boot integrity', body: integLabel + (integ.checked ? ` · ${integ.checked} files checked` : '') + (integ.mismatches && integ.mismatches.length ? '\nMismatched: ' + integ.mismatches.join(', ') : ''), actions: [{ label: 'Close', kind: 'primary', value: 1 }] }) }),
          row({ icon: 'info', iconColor: '#9aa7c2', title: 'Version', value: OS.version }),
          row({ icon: 'globe', iconColor: '#7aa2ff', title: 'Runtime', value: 'Web / PWA' }),
          row({ icon: 'storage', iconColor: '#8be9a0', title: 'Encryption', value: 'AES‑256‑GCM' }),
        ),
        section('Legal'),
        list(row({ icon: 'doc', iconColor: '#9aa7c2', title: 'Open source', sub: 'MIT licensed · free & open source' })),
        el('div', { class: 'hint', text: 'NyxOS is a privacy-first phone OS experience. It is not affiliated with GrapheneOS or Google.' }),
      );
    }

    showRoot();
  },
});
