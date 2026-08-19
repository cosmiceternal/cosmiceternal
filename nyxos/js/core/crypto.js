// Real client-side cryptography via Web Crypto (SubtleCrypto).
// The vault key is derived from the user's PIN with PBKDF2; data at rest is
// AES-256-GCM ciphertext. Without the PIN, stored bytes are unreadable — the
// in-spirit analog of filesystem-based disk encryption.
const enc = new TextEncoder();
const dec = new TextDecoder();

export const PBKDF2_ITERS = 210_000;

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function toB64(bytes) {
  let s = '';
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
export function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function sha256Hex(input) {
  const data = typeof input === 'string' ? enc.encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Derive an AES-GCM CryptoKey from a PIN + salt. */
export async function deriveKey(pin, salt, iterations = PBKDF2_ITERS) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt instanceof Uint8Array ? salt : fromB64(salt), iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt an object → base64(iv | ciphertext). */
export async function encryptJSON(key, obj) {
  const iv = randomBytes(12);
  const plaintext = enc.encode(JSON.stringify(obj));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const packed = new Uint8Array(iv.length + cipher.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(cipher), iv.length);
  return toB64(packed);
}

/** Decrypt base64(iv | ciphertext) → object. Throws on wrong key / tamper. */
export async function decryptJSON(key, b64) {
  const packed = fromB64(b64);
  const iv = packed.slice(0, 12);
  const cipher = packed.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return JSON.parse(dec.decode(plain));
}
