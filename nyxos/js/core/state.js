// In-memory OS state for the unlocked profile, plus persistence + change events.
import { Store } from './store.js';
import { encryptJSON } from './crypto.js';
import { emitter, uuid } from './util.js';

export const WALLPAPERS = [
  { id: 'nebula', name: 'Nebula' },
  { id: 'aurora', name: 'Aurora' },
  { id: 'void', name: 'Void' },
  { id: 'dawn', name: 'Dawn' },
  { id: 'forest', name: 'Forest' },
];

export const ACCENTS = ['#6ee7d0', '#7aa2ff', '#c58cff', '#ff9e7a', '#ffd166', '#8be9a0', '#ff8fb0'];

/** Fresh per-profile vault. */
export function defaultVault(name = 'Owner', color = '#6ee7d0') {
  return {
    version: 1,
    meta: { name, color },
    settings: {
      theme: 'dark',            // 'dark' | 'light' | 'system'
      accent: '#6ee7d0',
      wallpaper: 'nebula',
      brightness: 1,
      fontScale: 1,
    },
    toggles: {                  // quick-settings / connectivity (simulated radios)
      wifi: true, wifiName: 'NyxNet', airplane: false, bluetooth: false,
      dnd: false, flashlight: false, location: true, autoRotate: true,
      routing: 'direct',        // 'direct' | 'vpn' | 'tor'
      cast: false,
    },
    security: {
      lockUsb: true,            // block USB data on lockscreen
      lockCamera: false,        // block camera from lockscreen
      lockQuickTiles: true,     // no quick tiles when locked
      hideNotifContent: true,   // sensitive notifications hidden on lockscreen
      hidePasswords: true,      // mask password entry
      keyboardSuggestions: false, // personalized suggestions off by default
      clipboardNotify: true,    // notify on clipboard access
      sensorsGlobal: true,      // master sensors availability
      autoLockMs: 30_000,
      advancedProtection: false,
    },
    apps: {
      perms: {},                // { [appId]: {network, sensors, location, camera, mic, clipboard, storageScope, notifications} }
    },
    data: {},                   // { [appId]: {...} }  scoped storage
    notifications: [],          // { id, appId, title, text, ts, sensitive, read }
    clipboard: null,            // { text, ts, byApp }
  };
}

class OSState {
  constructor() {
    this.device = null;
    this.vault = null;
    this.key = null;
    this.activeId = null;
    this.screenLocked = false;
    this.events = emitter();
    this._saveTimer = null;
  }

  init() {
    this.device = Store.loadDevice();
    if (!this.device) {
      this.device = { profiles: [], activeId: null, integrity: null, createdAt: Date.now() };
      Store.saveDevice(this.device);
    }
    return this.device;
  }

  saveDevice() { Store.saveDevice(this.device); }

  // Locked from the user's perspective (screen lock OR data lock).
  get locked() { return this.screenLocked || !this.vault || !this.key; }
  // Data-at-rest lock (before first unlock / after reboot): vault not in memory.
  get dataLocked() { return !this.vault || !this.key; }

  unlock(id, key, vault) {
    this.activeId = id;
    this.key = key;
    this.vault = vault;
    this.screenLocked = false;
    this.device.activeId = id;
    this.saveDevice();
    this.events.emit('unlock');
  }

  // Screen lock (after first unlock): keep the key in memory so the lock screen
  // can show notifications, exactly like a phone in the AFU state. Data at rest
  // stays encrypted (the persisted blob is always ciphertext).
  screenLock() {
    this.persistNow();
    this.screenLocked = true;
    this.events.emit('lock');
  }

  unlockScreen() {
    this.screenLocked = false;
    this.events.emit('unlock');
  }

  // Full lock / eviction (reboot, profile switch): drop the key and plaintext.
  lock() {
    this.persistNow();
    this.vault = null;
    this.key = null;
    this.screenLocked = true;
    this.events.emit('lock');
  }

  // --- path get/set on the vault --------------------------------------
  get(path, fallback) {
    const parts = path.split('.');
    let cur = this.vault;
    for (const p of parts) { if (cur == null) return fallback; cur = cur[p]; }
    return cur === undefined ? fallback : cur;
  }

  set(path, value, { silent = false } = {}) {
    const parts = path.split('.');
    let cur = this.vault;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (typeof cur[p] !== 'object' || cur[p] == null) cur[p] = {};
      cur = cur[p];
    }
    cur[parts[parts.length - 1]] = value;
    this.persist();
    if (!silent) this.events.emit('change', path, value);
    return value;
  }

  update(fn) { fn(this.vault); this.persist(); this.events.emit('change', '*'); }

  // --- persistence (debounced encryption) -----------------------------
  persist() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.persistNow(), 250);
  }
  async persistNow() {
    if (!this.vault || !this.key || !this.activeId) return;
    try {
      const blob = await encryptJSON(this.key, this.vault);
      Store.saveVaultBlob(this.activeId, blob);
    } catch (e) { console.error('persist failed', e); }
  }

  // --- convenience ----------------------------------------------------
  addProfileRecord(name, color) {
    const id = uuid();
    this.device.profiles.push({ id, name, color, createdAt: Date.now() });
    this.saveDevice();
    return id;
  }
}

export const State = new OSState();
