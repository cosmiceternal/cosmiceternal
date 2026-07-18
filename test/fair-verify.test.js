'use strict';

// The in-browser Provably-Fair verifier (public/js/fair.js) must reproduce the
// server's float stream and commitment hash EXACTLY, or players would compute
// different numbers than the server drew and (wrongly) distrust the game. This
// guards the two implementations against silent divergence by running the
// client algorithm through the same WebCrypto engine the browser uses.

const test = require('node:test');
const assert = require('node:assert/strict');
const { subtle } = require('node:crypto').webcrypto;
const fs = require('node:fs');
const path = require('node:path');
const server = require('../server/fair.js');

// Client algorithm — kept in lockstep with public/js/fair.js floatsFrom/sha256Hex.
async function clientFloats(seed, client, nonce, count) {
  const enc = new TextEncoder();
  const key = await subtle.importKey('raw', enc.encode(seed), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const out = []; let round = 0;
  while (out.length < count && round < 64) {
    const sig = new Uint8Array(await subtle.sign('HMAC', key, enc.encode(`${client}:${nonce}:${round}`)));
    for (let i = 0; i + 4 <= sig.length && out.length < count; i += 4) {
      out.push(sig[i] / 256 + sig[i + 1] / 65536 + sig[i + 2] / 16777216 + sig[i + 3] / 4294967296);
    }
    round++;
  }
  return out;
}
async function clientSha(str) {
  const b = await subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

test('client verifier reproduces server floats + commitment exactly', async () => {
  for (const [nonce, count] of [[0, 8], [1, 8], [7, 12], [42, 3], [100, 20]]) {
    const seed = server.randomHex(32);
    const client = 'client-' + nonce;
    const s = server.floatsFrom(seed, client, nonce, count);
    const c = await clientFloats(seed, client, nonce, count);
    assert.equal(c.length, s.length, `float count for nonce ${nonce}`);
    for (let i = 0; i < s.length; i++) assert.ok(Math.abs(s[i] - c[i]) < 1e-15, `float ${i} @ nonce ${nonce}: ${s[i]} vs ${c[i]}`);
    assert.equal(await clientSha(seed), server.sha256Hex(seed), 'commitment hash must match');
  }
});

test('client fair.js keeps the exact HMAC message shape the server uses', () => {
  // The message is `${clientSeed}:${nonce}:${round}` (three fields) and the key
  // is the hex STRING — a drift here is the classic verifier-mismatch bug.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'fair.js'), 'utf8');
  assert.ok(src.includes('${clientSeed}:${nonce}:${round}'), 'client must hash the 3-field message');
  assert.ok(/importKey\('raw', enc\.encode\(serverSeed\)/.test(src), 'client must key HMAC with the seed hex string');
});
