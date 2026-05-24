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

  global.Fair = { refresh, getState, bumpNonce, setClientSeed, rotate, getHistory, subscribe };
})(window);
