// Credential lifecycle: PIN or passphrase, duress detection, brute-force
// throttling, and optional auto-wipe. A profile's data key is derived from its
// secret; we never store the secret, only a salt + an encrypted verifier token.
// Attempt counters live in the (plaintext) profile meta so they can be enforced
// before the vault is decrypted — the honest browser analog of a phone's
// hardware-throttled keystore (documented as such in the Security screen).
import { Store } from './store.js';
import { deriveKey, encryptJSON, decryptJSON, randomBytes, toB64, PBKDF2_ITERS } from './crypto.js';
import { State, defaultVault } from './state.js';

const VERIFIER = { magic: 'nyxos.verify.v1' };

async function makeVerifier(secret, salt, iterations) {
  const key = await deriveKey(secret, salt, iterations);
  const verifier = await encryptJSON(key, VERIFIER);
  return { key, verifier };
}

// --- Security audit log (device-level, non-sensitive: types + timestamps) ---
export function logEvent(type) {
  try {
    const d = State.device;
    if (!d) return;
    d.secLog = d.secLog || [];
    d.secLog.unshift({ ts: Date.now(), type });
    if (d.secLog.length > 40) d.secLog.length = 40;
    State.saveDevice();
  } catch { /* logging must never throw */ }
}
export function securityLog() { return State.device?.secLog || []; }
export function clearSecurityLog() { if (State.device) { State.device.secLog = []; State.saveDevice(); } }

/**
 * Verify a secret WITHOUT any side effects (no counters, no throttle, no vault
 * load). Used to re-authenticate before sensitive settings changes.
 */
export async function verifySecret(profileId, secret) {
  const meta = Store.loadMeta(profileId);
  if (!meta) return false;
  try {
    const key = await deriveKey(secret, meta.salt, meta.iterations);
    const check = await decryptJSON(key, meta.verifier);
    return !!(check && check.magic === VERIFIER.magic);
  } catch { return false; }
}

/** Escalating delay after repeated failures: 5→30s, 6→60s, 7→2m … capped 30m. */
export function backoffMs(fails) {
  if (fails < 5) return 0;
  return Math.min(30_000 * 2 ** (fails - 5), 1_800_000);
}

/** Create a profile's credential + initial encrypted vault. */
export async function setupPin(profileId, secret, { name, color, mode = 'pin' } = {}) {
  const salt = randomBytes(16);
  const iterations = PBKDF2_ITERS;
  const { key, verifier } = await makeVerifier(secret, salt, iterations);
  const meta = { salt: toB64(salt), iterations, verifier, duress: null, mode, fails: 0, lockUntil: 0, autoWipe: 0, createdAt: Date.now() };
  Store.saveMeta(profileId, meta);

  const vault = defaultVault(name, color);
  vault.meta = { name: name || 'Owner', color: color || vault.settings.accent };
  const blob = await encryptJSON(key, vault);
  Store.saveVaultBlob(profileId, blob);
  return { key, vault };
}

/**
 * Verify a secret against a profile, enforcing throttling and auto-wipe.
 * @returns {status:'ok',key,vault} | {status:'duress'} | {status:'wipe'}
 *          | {status:'throttled',until} | {status:'fail',fails,remaining,until}
 */
export async function verifyPin(profileId, secret) {
  const meta = Store.loadMeta(profileId);
  if (!meta) return { status: 'fail' };

  const now = Date.now();
  if (meta.lockUntil && now < meta.lockUntil) return { status: 'throttled', until: meta.lockUntil };

  // Correct secret?
  try {
    const key = await deriveKey(secret, meta.salt, meta.iterations);
    const check = await decryptJSON(key, meta.verifier);
    if (check && check.magic === VERIFIER.magic) {
      if (meta.fails || meta.lockUntil) { meta.fails = 0; meta.lockUntil = 0; Store.saveMeta(profileId, meta); }
      const blob = Store.loadVaultBlob(profileId);
      const vault = blob ? await decryptJSON(key, blob) : defaultVault();
      logEvent('unlock');
      return { status: 'ok', key, vault };
    }
  } catch { /* wrong secret → GCM auth fails */ }

  // Duress secret? (a "correct" secret that triggers a wipe — not a failed try)
  if (meta.duress) {
    try {
      const dkey = await deriveKey(secret, meta.duress.salt, meta.duress.iterations);
      const dcheck = await decryptJSON(dkey, meta.duress.verifier);
      if (dcheck && dcheck.magic === VERIFIER.magic) return { status: 'duress' };
    } catch { /* not the duress secret either */ }
  }

  // Failed attempt: count it, maybe auto-wipe, otherwise throttle.
  meta.fails = (meta.fails || 0) + 1;
  logEvent('unlock-failed');
  const wipeAt = meta.autoWipe || 0;
  if (wipeAt && meta.fails >= wipeAt) { logEvent('auto-wipe'); return { status: 'wipe', fails: meta.fails }; }
  meta.lockUntil = meta.fails >= 5 ? now + backoffMs(meta.fails) : 0;
  if (meta.lockUntil) logEvent('lockout');
  Store.saveMeta(profileId, meta);
  return {
    status: 'fail',
    fails: meta.fails,
    remaining: wipeAt ? Math.max(0, wipeAt - meta.fails) : null,
    until: meta.lockUntil,
  };
}

/** Public (pre-unlock) view of a profile's credential state, for the lock screen. */
export function getPublicMeta(profileId) {
  const meta = Store.loadMeta(profileId);
  if (!meta) return null;
  return {
    mode: meta.mode || 'pin',
    fails: meta.fails || 0,
    lockUntil: meta.lockUntil || 0,
    autoWipe: meta.autoWipe || 0,
    hasDuress: !!meta.duress,
  };
}

/** Set (or clear) the duress secret for a profile. */
export async function setDuressPin(profileId, secret) {
  const meta = Store.loadMeta(profileId);
  if (!meta) throw new Error('no profile');
  if (!secret) { meta.duress = null; Store.saveMeta(profileId, meta); logEvent('duress-cleared'); return; }
  const salt = randomBytes(16);
  const iterations = PBKDF2_ITERS;
  const { verifier } = await makeVerifier(secret, salt, iterations);
  meta.duress = { salt: toB64(salt), iterations, verifier };
  Store.saveMeta(profileId, meta);
  logEvent('duress-set');
}

export function hasDuress(profileId) {
  const meta = Store.loadMeta(profileId);
  return !!(meta && meta.duress);
}

/** Configure auto-wipe threshold (0 = off). Stored in meta so it applies pre-unlock. */
export function setAutoWipe(profileId, n) {
  const meta = Store.loadMeta(profileId);
  if (!meta) return;
  meta.autoWipe = Math.max(0, n | 0);
  Store.saveMeta(profileId, meta);
}

/** Change a profile's credential, re-encrypting the current in-memory vault. */
export async function changePin(profileId, newSecret, mode = 'pin') {
  const salt = randomBytes(16);
  const iterations = PBKDF2_ITERS;
  const { key, verifier } = await makeVerifier(newSecret, salt, iterations);
  const meta = Store.loadMeta(profileId) || {};
  meta.salt = toB64(salt);
  meta.iterations = iterations;
  meta.verifier = verifier;
  meta.mode = mode;
  meta.fails = 0;
  meta.lockUntil = 0;
  Store.saveMeta(profileId, meta);
  State.key = key;
  await State.persistNow();
  logEvent('credential-changed');
  return key;
}

/** Destroy all NyxOS data on the device (duress or auto-wipe). */
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
