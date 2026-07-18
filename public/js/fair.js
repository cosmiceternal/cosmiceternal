/* Provably-fair UI. Seeds now live on the server; this module fetches the
 * public commitment (server-seed hash, client seed, nonce), lets the player
 * change the client seed or rotate the server seed (revealing the old one),
 * and shows recent rolls. */
(function (global) {
  'use strict';

  let state = { serverHash: '', clientSeed: '', nonce: 0, revealedSeed: null };
  const subs = new Set();

  async function refresh() {
    try {
      state = await API.fair();
      notify();
    } catch (e) {}
    return state;
  }
  function getState() { return Object.assign({}, state); }
  // Bumped locally after each bet so the displayed nonce stays live without a refetch.
  function bumpNonce() { state.nonce = (state.nonce || 0) + 1; notify(); }

  async function setClientSeed(seed) {
    state = await API.setClient(seed);
    notify();
    return state;
  }
  async function rotate() {
    const r = await API.rotate();
    state = r.state;
    notify();
    return r;
  }
  async function getHistory(n) {
    const r = await API.fairHistory(n);
    return r.rolls;
  }

  function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }
  function notify() { subs.forEach(fn => { try { fn(getState()); } catch (e) {} }); }

  // ---- Independent client-side verification (mirrors server/fair.js exactly) ----
  // The server commits to server_hash = SHA-256(serverSeed) where serverSeed is
  // the 64-char hex STRING, and draws floats from HMAC-SHA256(serverSeed,
  // `${clientSeed}:${nonce}:${round}`), 4 bytes at a time as a base-256 fraction.
  // Both are reproduced here with WebCrypto so a skeptic can confirm the numbers
  // without trusting us. Requires a secure context (https or localhost).
  function hasSubtle() { return !!(global.crypto && global.crypto.subtle); }
  async function sha256Hex(str) {
    if (!hasSubtle()) throw new Error('secure context required');
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  async function floatsFrom(serverSeed, clientSeed, nonce, count) {
    if (!hasSubtle()) throw new Error('secure context required');
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(serverSeed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const out = []; let round = 0;
    while (out.length < count && round < 64) {
      const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${clientSeed}:${nonce}:${round}`)));
      for (let i = 0; i + 4 <= sig.length && out.length < count; i += 4) {
        out.push(sig[i] / 256 + sig[i + 1] / 65536 + sig[i + 2] / 16777216 + sig[i + 3] / 4294967296);
      }
      round++;
    }
    return out;
  }

  global.Fair = { refresh, getState, bumpNonce, setClientSeed, rotate, getHistory, subscribe, sha256Hex, floatsFrom, hasSubtle };
})(window);
