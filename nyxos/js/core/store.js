// Low-level persistence over localStorage.
//  - Device config (`nyxos.device`) is plaintext: it must be readable before any
//    PIN is entered (profile list, active profile, integrity baseline).
//  - Per-profile meta holds the KDF salt + an encrypted verifier used to check the
//    PIN without storing it.
//  - Per-profile vault is opaque AES-GCM ciphertext — unreadable without the PIN.

const DEVICE_KEY = 'nyxos.device';
const pMeta = (id) => `nyxos.profile.${id}.meta`;
const pVault = (id) => `nyxos.profile.${id}.vault`;

function readJSON(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch (e) { console.error('store write failed', key, e); return false; }
}

export const Store = {
  loadDevice() { return readJSON(DEVICE_KEY, null); },
  saveDevice(cfg) { return writeJSON(DEVICE_KEY, cfg); },

  loadMeta(id) { return readJSON(pMeta(id), null); },
  saveMeta(id, meta) { return writeJSON(pMeta(id), meta); },

  loadVaultBlob(id) { return localStorage.getItem(pVault(id)); },
  saveVaultBlob(id, blob) {
    try { localStorage.setItem(pVault(id), blob); return true; }
    catch (e) { console.error('vault write failed', e); return false; }
  },

  wipeProfile(id) {
    localStorage.removeItem(pMeta(id));
    localStorage.removeItem(pVault(id));
  },

  // Total device wipe (duress). Removes every NyxOS key.
  wipeAll() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('nyxos.')) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  },
};
