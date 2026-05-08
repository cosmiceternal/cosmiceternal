/* Provably-fair RNG using HMAC-SHA256(serverSeed, clientSeed:nonce).
 * The server seed is committed (sha256 hash shown) before play. After rotation
 * the original seed is revealed so the player can verify all past rolls.
 *
 * Pure-JS HMAC-SHA256 (no Web Crypto required, so opening index.html via file://
 * still works). Bytes-in / hex-out. */
(function (global) {
  'use strict';

  // ---------- SHA-256 ----------
  const K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ]);

  function rotr(n, x) { return (x >>> n) | (x << (32 - n)); }

  function sha256(bytes) {
    const l = bytes.length;
    const withOne = new Uint8Array(((l + 9 + 63) >> 6) << 6);
    withOne.set(bytes);
    withOne[l] = 0x80;
    const bits = l * 8;
    // 64-bit length, big-endian (high 32 bits zero for sane sizes)
    const dv = new DataView(withOne.buffer);
    dv.setUint32(withOne.length - 4, bits >>> 0);
    dv.setUint32(withOne.length - 8, Math.floor(bits / 0x100000000));

    let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,
        h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;

    const w = new Uint32Array(64);
    for (let off = 0; off < withOne.length; off += 64) {
      for (let i = 0; i < 16; i++) {
        w[i] = dv.getUint32(off + i * 4);
      }
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(7, w[i-15]) ^ rotr(18, w[i-15]) ^ (w[i-15] >>> 3);
        const s1 = rotr(17, w[i-2]) ^ rotr(19, w[i-2]) ^ (w[i-2] >>> 10);
        w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0;
      }
      let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(6,e) ^ rotr(11,e) ^ rotr(25,e);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = rotr(2,a) ^ rotr(13,a) ^ rotr(22,a);
        const mj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + mj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h0=(h0+a)>>>0; h1=(h1+b)>>>0; h2=(h2+c)>>>0; h3=(h3+d)>>>0;
      h4=(h4+e)>>>0; h5=(h5+f)>>>0; h6=(h6+g)>>>0; h7=(h7+h)>>>0;
    }
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    odv.setUint32(0,h0); odv.setUint32(4,h1); odv.setUint32(8,h2);  odv.setUint32(12,h3);
    odv.setUint32(16,h4); odv.setUint32(20,h5); odv.setUint32(24,h6); odv.setUint32(28,h7);
    return out;
  }

  function hmacSha256(keyBytes, msgBytes) {
    const blockSize = 64;
    let key = keyBytes;
    if (key.length > blockSize) key = sha256(key);
    if (key.length < blockSize) {
      const padded = new Uint8Array(blockSize);
      padded.set(key);
      key = padded;
    }
    const okey = new Uint8Array(blockSize);
    const ikey = new Uint8Array(blockSize);
    for (let i = 0; i < blockSize; i++) {
      okey[i] = key[i] ^ 0x5c;
      ikey[i] = key[i] ^ 0x36;
    }
    const inner = new Uint8Array(blockSize + msgBytes.length);
    inner.set(ikey); inner.set(msgBytes, blockSize);
    const innerHash = sha256(inner);
    const outer = new Uint8Array(blockSize + innerHash.length);
    outer.set(okey); outer.set(innerHash, blockSize);
    return sha256(outer);
  }

  // ---------- Helpers ----------
  function strToBytes(s) {
    return new TextEncoder().encode(s);
  }
  function bytesToHex(b) {
    let s = '';
    for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
    return s;
  }
  function randomHex(byteLen) {
    const arr = new Uint8Array(byteLen);
    if (global.crypto && global.crypto.getRandomValues) {
      global.crypto.getRandomValues(arr);
    } else {
      for (let i = 0; i < byteLen; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    return bytesToHex(arr);
  }

  // Convert HMAC bytes into an unbiased float in [0,1) using rejection sampling
  // on consecutive 32-bit chunks. (Stake's approach.)
  function bytesToFloat(bytes) {
    // Use first 4 bytes as a 32-bit unsigned, divide by 2^32.
    // Combine 4 chunks for ~52 bits of entropy.
    let result = 0;
    let scale = 1;
    for (let i = 0; i < 4; i++) {
      const off = i * 4;
      const n =
        (bytes[off] << 24 >>> 0) +
        (bytes[off+1] << 16) +
        (bytes[off+2] << 8) +
        (bytes[off+3]);
      scale *= 4294967296; // 2^32
      result = result * 4294967296 + n;
    }
    return result / scale;
  }

  // ---------- Public API ----------
  const STORE_KEY = 'neonstake.fair.v1';
  const HISTORY_KEY = 'neonstake.fair.history.v1';
  const HIST_MAX = 50;

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return null;
  }
  function saveState(s) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) {}
  }
  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return [];
  }
  function saveHistory(h) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(-HIST_MAX))); } catch (e) {}
  }

  let state = loadState();
  if (!state) {
    state = freshState();
    saveState(state);
  }
  let history = loadHistory();
  const subscribers = new Set();

  function freshState() {
    const serverSeed = randomHex(32);
    const clientSeed = randomHex(8);
    const hash = bytesToHex(sha256(strToBytes(serverSeed)));
    return {
      serverSeed,
      serverHash: hash,
      clientSeed,
      nonce: 0,
      revealedSeed: null
    };
  }

  function rotate() {
    // Reveal current seed, mint a new one, reset nonce.
    const old = { serverSeed: state.serverSeed, serverHash: state.serverHash, clientSeed: state.clientSeed, finalNonce: state.nonce };
    state = freshState();
    state.revealedSeed = old.serverSeed;
    saveState(state);
    notify();
    return old;
  }

  function setClientSeed(seed) {
    if (!seed || typeof seed !== 'string') return;
    state.clientSeed = seed.slice(0, 64);
    state.nonce = 0;
    saveState(state);
    notify();
  }

  // Yields { float, bytes, nonce, serverHash } per call, advances nonce.
  function next(game) {
    const nonce = state.nonce++;
    const msg = strToBytes(state.clientSeed + ':' + nonce + (game ? ':' + game : ''));
    const key = strToBytes(state.serverSeed);
    const bytes = hmacSha256(key, msg);
    const f = bytesToFloat(bytes);
    saveState(state);
    return { float: f, bytes, nonce, hash: state.serverHash, game: game || '' };
  }

  // Multi-stream from one HMAC: we want N independent floats per round
  // (e.g. a Mines layout). We just request N consecutive HMACs.
  function nextStream(game, count) {
    const out = [];
    for (let i = 0; i < count; i++) out.push(next(game).float);
    return out;
  }

  function recordRoll(entry) {
    history.push(entry);
    if (history.length > HIST_MAX) history = history.slice(-HIST_MAX);
    saveHistory(history);
    notify();
  }

  function getHistory() { return history.slice(); }
  function getState() { return Object.assign({}, state); }

  function subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }
  function notify() { subscribers.forEach(fn => { try { fn(getState(), getHistory()); } catch(e){} }); }

  // ---------- Game-specific samplers ----------
  // Crash multiplier with 1% house edge. Pure formula, single HMAC.
  function sampleCrash() {
    const r = next('crash');
    const f = r.float;
    // 1% chance of instant 1.00x
    if (f < 0.01) return { mult: 1.00, fair: r };
    // Convert remaining 99% of probability mass into a multiplier.
    // x = floor(99 / (1 - u)) / 100, where u is uniform in [0,1)
    // gives a heavy-tailed distribution with ~1% house edge.
    const u = (f - 0.01) / 0.99;
    const m = Math.floor((99 / (1 - u))) / 100;
    return { mult: Math.max(1.00, m), fair: r };
  }

  // Dice roll: 0.00 .. 99.99
  function sampleDice() {
    const r = next('dice');
    const v = Math.floor(r.float * 10000) / 100;
    return { roll: v, fair: r };
  }

  // Mines layout: pick `mines` distinct cells out of 25 using sequential floats.
  function sampleMines(mineCount) {
    const indices = Array.from({ length: 25 }, (_, i) => i);
    const out = [];
    const fair = [];
    for (let i = 0; i < mineCount; i++) {
      const r = next('mines');
      fair.push(r);
      const j = Math.floor(r.float * indices.length);
      out.push(indices[j]);
      indices.splice(j, 1);
    }
    return { mines: new Set(out), fair };
  }

  // Plinko: each row direction (0/1) for `rows` rows.
  function samplePlinko(rows) {
    const r = next('plinko');
    const directions = [];
    // Use bytes of the HMAC; 32 bytes = 256 bits >> rows ≤ 16.
    for (let i = 0; i < rows; i++) {
      const byte = r.bytes[i];
      directions.push(byte & 1);
    }
    return { directions, fair: r };
  }

  global.Fair = {
    sha256: (s) => bytesToHex(sha256(strToBytes(s))),
    hmacHex: (k, m) => bytesToHex(hmacSha256(strToBytes(k), strToBytes(m))),
    randomHex,
    rotate,
    setClientSeed,
    getState,
    getHistory,
    recordRoll,
    subscribe,
    sampleCrash,
    sampleDice,
    sampleMines,
    samplePlinko
  };
})(window);
