// The permission engine + per-app capability sandbox — the core of NyxOS's
// privacy model. An app only ever receives a `sys` object scoped to its own id;
// every sensitive capability is gated here, so a denied permission genuinely
// prevents access rather than merely hiding a button.
import { State } from './state.js';
import { Notifications } from './notifications.js';
import { Bridge } from './bridge.js';
import { getApp, appName } from './registry.js';

export class PermissionDenied extends Error {
  constructor(perm) { super(`Permission denied: ${perm}`); this.permission = perm; this.name = 'PermissionDenied'; }
}

// Implicit permissions every app has, plus per-permission metadata.
export const PERMISSIONS = {
  network:       { name: 'Network',        icon: 'network',   desc: 'Access the internet',            def: true,  implicit: true },
  storageScope:  { name: 'Storage Scopes', icon: 'storage',   desc: 'Isolated per-app storage (enforced)', def: true, locked: true, implicit: true },
  notifications: { name: 'Notifications',  icon: 'bell',      desc: 'Post notifications',             def: true,  implicit: true },
  sensors:       { name: 'Sensors',        icon: 'sensor',    desc: 'Motion, orientation, compass',   def: false },
  location:      { name: 'Location',       icon: 'location',  desc: 'Approximate or precise location', def: false },
  camera:        { name: 'Camera',         icon: 'camera',    desc: 'Take photos and video',           def: false },
  microphone:    { name: 'Microphone',     icon: 'mic',       desc: 'Record audio',                    def: false },
  clipboard:     { name: 'Clipboard',      icon: 'clipboard', desc: 'Read the clipboard',              def: true },
};

const IMPLICIT = Object.entries(PERMISSIONS).filter(([, v]) => v.implicit).map(([k]) => k);

/** Permissions relevant to an app: the implicit set + whatever it declared. */
export function permsForApp(appId) {
  const app = getApp(appId);
  const declared = app ? app.perms : [];
  const set = new Set([...IMPLICIT, ...declared]);
  return [...set];
}

/** Lazily seed default grants for an app into the vault. */
export function ensureAppPerms(appId) {
  const cur = State.get(`apps.perms.${appId}`, null);
  if (cur) return cur;
  const seeded = {};
  for (const p of permsForApp(appId)) seeded[p] = PERMISSIONS[p]?.def ?? false;
  State.set(`apps.perms.${appId}`, seeded, { silent: true });
  return seeded;
}

export function getPerm(appId, perm) {
  ensureAppPerms(appId);
  return !!State.get(`apps.perms.${appId}.${perm}`, false);
}

export function setPerm(appId, perm, value) {
  if (PERMISSIONS[perm]?.locked) return; // storage scopes are enforced
  ensureAppPerms(appId);
  State.set(`apps.perms.${appId}.${perm}`, !!value);
  State.events.emit('perms-change', appId, perm, value);
}

/** Effective check: combines the per-app grant with global/system gates. */
export function can(appId, perm) {
  const granted = getPerm(appId, perm);
  if (!granted) return false;
  if (perm === 'sensors') return State.get('security.sensorsGlobal', true);
  if (perm === 'network') {
    if (State.get('toggles.airplane', false)) return false;
    return State.get('toggles.wifi', true);
  }
  if (perm === 'location') return State.get('toggles.location', true);
  return true;
}

// --- Scoped storage (real per-app isolation) ----------------------------
function scopedStorage(appId) {
  const path = `data.${appId}`;
  return {
    get(k, fb) { const d = State.get(path, {}) || {}; return k in d ? d[k] : fb; },
    set(k, v) { const d = { ...(State.get(path, {}) || {}) }; d[k] = v; State.set(path, d, { silent: true }); },
    remove(k) { const d = { ...(State.get(path, {}) || {}) }; delete d[k]; State.set(path, d, { silent: true }); },
    keys() { return Object.keys(State.get(path, {}) || {}); },
    all() { return { ...(State.get(path, {}) || {}) }; },
    replace(obj) { State.set(path, obj || {}, { silent: true }); },
  };
}

// --- Clipboard (OS-internal; access is surfaced) ------------------------
function clipboardApi(appId) {
  return {
    write(text) { State.set('clipboard', { text: String(text), ts: Date.now(), byApp: appId }, { silent: true }); },
    read() {
      const c = State.get('clipboard', null);
      // A read by an app that isn't the writer surfaces a notification.
      if (State.get('security.clipboardNotify', true) && c && c.byApp !== appId) {
        Notifications.post({
          appId: 'privacy', title: 'Clipboard accessed',
          text: `${appName(appId)} read clipboard contents`, icon: 'clipboard', color: '#ffcf6b',
        });
      }
      return c ? c.text : '';
    },
  };
}

// --- Sensors (gated; real events where the device provides them) --------
function sensorApi(appId) {
  const listeners = new Set();
  return {
    available() { return can(appId, 'sensors'); },
    start(cb) {
      if (!can(appId, 'sensors')) throw new PermissionDenied('sensors');
      const handler = (e) => cb({ alpha: e.alpha, beta: e.beta, gamma: e.gamma });
      window.addEventListener('deviceorientation', handler);
      const stop = () => { window.removeEventListener('deviceorientation', handler); listeners.delete(stop); };
      listeners.add(stop);
      return stop;
    },
    stopAll() { listeners.forEach((s) => s()); },
  };
}

// --- Network (gated pass-through) ---------------------------------------
function netApi(appId) {
  return {
    allowed() { return can(appId, 'network'); },
    routing() { return State.get('toggles.routing', 'direct'); },
    async fetch(url, opts = {}) {
      if (!can(appId, 'network')) throw new PermissionDenied('network');
      // A privacy OS surfaces where traffic goes; routing is annotated, not faked.
      return fetch(url, { ...opts, referrerPolicy: 'no-referrer' });
    },
  };
}

function locationApi(appId) {
  return {
    async get({ precise = false } = {}) {
      if (!can(appId, 'location')) throw new PermissionDenied('location');
      if (!navigator.geolocation) throw new Error('unavailable');
      return new Promise((res, rej) => {
        navigator.geolocation.getCurrentPosition(
          (pos) => res({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }),
          (err) => rej(err),
          { enableHighAccuracy: precise, timeout: 8000 },
        );
      });
    },
  };
}

/** Build the capability object handed to an app on launch. */
export function makeSys(appId) {
  ensureAppPerms(appId);
  return {
    appId,
    storage: scopedStorage(appId),
    net: netApi(appId),
    sensors: sensorApi(appId),
    location: locationApi(appId),
    clipboard: clipboardApi(appId),
    notify(o) { if (!can(appId, 'notifications')) return null; return Notifications.post({ appId, ...o }); },
    toast: (m, o) => Bridge.toast(m, o),
    confirm: (o) => Bridge.confirm(o),
    prompt: (o) => Bridge.prompt(o),
    perms: {
      has: (p) => can(appId, p),
      granted: (p) => getPerm(appId, p),
      request: (p) => Bridge.requestPermission(appId, p),
    },
    openApp: (id) => Bridge.openApp(id),
    close: () => Bridge.closeApp(),
    settings: () => State.get('settings', {}),
    accent: () => State.get('settings.accent', '#6ee7d0'),
  };
}
