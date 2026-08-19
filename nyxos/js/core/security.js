// PIN lifecycle + duress detection. A profile's data key is derived from its PIN;
// we never store the PIN, only a salt and an encrypted verifier token.
import { Store } from './store.js';
import { deriveKey, encryptJSON, decryptJSON, randomBytes, toB64, PBKDF2_ITERS } from './crypto.js';
import { State, defaultVault } from './state.js';

const VERIFIER = { magic: 'nyxos.verify.v1' };

async function makeVerifier(pin, salt, iterations) {
  const key = await deriveKey(pin, salt, iterations);
  const verifier = await encryptJSON(key, VERIFIER);
  return { key, verifier };
}

/** Create a profile's PIN + initial encrypted vault. */
export async function setupPin(profileId, pin, { name, color } = {}) {
  const salt = randomBytes(16);
  const iterations = PBKDF2_ITERS;
  const { key, verifier } = await makeVerifier(pin, salt, iterations);
  const meta = { salt: toB64(salt), iterations, verifier, duress: null, createdAt: Date.now() };
  Store.saveMeta(profileId, meta);

  const vault = defaultVault(name, color);
  vault.meta = { name: name || 'Owner', color: color || vault.settings.accent };
  const blob = await encryptJSON(key, vault);
  Store.saveVaultBlob(profileId, blob);
  return { key, vault };
}

/**
 * Verify a PIN against a profile.
 * @returns {status:'ok', key, vault} | {status:'duress'} | {status:'fail'}
 */
export async function verifyPin(profileId, pin) {
  const meta = Store.loadMeta(profileId);
  if (!meta) return { status: 'fail' };

  // Normal PIN?
  try {
    const key = await deriveKey(pin, meta.salt, meta.iterations);
    const check = await decryptJSON(key, meta.verifier);
    if (check && check.magic === VERIFIER.magic) {
      const blob = Store.loadVaultBlob(profileId);
      const vault = blob ? await decryptJSON(key, blob) : defaultVault();
      return { status: 'ok', key, vault };
    }
  } catch { /* wrong pin → GCM auth fails */ }

  // Duress PIN?
  if (meta.duress) {
    try {
      const dkey = await deriveKey(pin, meta.duress.salt, meta.duress.iterations);
      const dcheck = await decryptJSON(dkey, meta.duress.verifier);
      if (dcheck && dcheck.magic === VERIFIER.magic) return { status: 'duress' };
    } catch { /* not the duress pin either */ }
  }

  return { status: 'fail' };
}

/** Set (or clear) the duress PIN for a profile. */
export async function setDuressPin(profileId, pin) {
  const meta = Store.loadMeta(profileId);
  if (!meta) throw new Error('no profile');
  if (!pin) { meta.duress = null; Store.saveMeta(profileId, meta); return; }
  const salt = randomBytes(16);
  const iterations = PBKDF2_ITERS;
  const { verifier } = await makeVerifier(pin, salt, iterations);
  meta.duress = { salt: toB64(salt), iterations, verifier };
  Store.saveMeta(profileId, meta);
}

export function hasDuress(profileId) {
  const meta = Store.loadMeta(profileId);
  return !!(meta && meta.duress);
}

/** Change a profile's PIN, re-encrypting the current in-memory vault. */
export async function changePin(profileId, newPin) {
  const salt = randomBytes(16);
  const iterations = PBKDF2_ITERS;
  const { key, verifier } = await makeVerifier(newPin, salt, iterations);
  const meta = Store.loadMeta(profileId) || {};
  meta.salt = toB64(salt);
  meta.iterations = iterations;
  meta.verifier = verifier;
  Store.saveMeta(profileId, meta);
  State.key = key;
  await State.persistNow();
  return key;
}

/**
 * Execute a duress wipe: destroy all NyxOS data on the device.
 * Faithful to GrapheneOS — the duress PIN wipes everything.
 */
export function duressWipe() {
  State.vault = null;
  State.key = null;
  Store.wipeAll();
}

// --- Auto-lock policy ----------------------------------------------------
export const LockPolicy = {
  _timer: null,
  _onLock: null,
  arm(onLock) { this._onLock = onLock; this.reset(); },
  disarm() { clearTimeout(this._timer); this._timer = null; },
  reset() {
    clearTimeout(this._timer);
    if (State.locked) return;
    const ms = State.get('security.autoLockMs', 30000);
    if (!ms) return; // 0 = never
    this._timer = setTimeout(() => this._onLock?.(), ms);
  },
};
