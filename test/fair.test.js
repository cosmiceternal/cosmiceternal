'use strict';

// Provably-fair stream tests. `floatsFrom(serverSeed, clientSeed, nonce, n)`
// must be deterministic — given the same inputs it returns the same floats,
// always. That's the invariant that lets a player replay a past roll after
// the server seed is revealed.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const fair = require('../server/fair.js');

test('floatsFrom is deterministic — same inputs produce same outputs', () => {
  const a = fair.floatsFrom('server-seed-aaaa', 'client-seed-bbbb', 0, 8);
  const b = fair.floatsFrom('server-seed-aaaa', 'client-seed-bbbb', 0, 8);
  assert.deepEqual(a, b);
});

test('floatsFrom changes when ANY input changes', () => {
  const base = fair.floatsFrom('server', 'client', 0, 4);
  const seedDiff   = fair.floatsFrom('SERVER', 'client', 0, 4);
  const clientDiff = fair.floatsFrom('server', 'CLIENT', 0, 4);
  const nonceDiff  = fair.floatsFrom('server', 'client', 1, 4);
  assert.notDeepEqual(base, seedDiff);
  assert.notDeepEqual(base, clientDiff);
  assert.notDeepEqual(base, nonceDiff);
});

test('floatsFrom outputs are in [0, 1)', () => {
  const N = 100;
  const xs = fair.floatsFrom('s', 'c', 0, N);
  assert.equal(xs.length, N);
  for (const x of xs) {
    assert.ok(x >= 0, `value ${x} below 0`);
    assert.ok(x < 1,  `value ${x} >= 1`);
  }
});

test('floatsFrom mean is near 0.5 across many nonces', () => {
  // 8 floats per HMAC, 1000 nonces → 8000 samples. SE ≈ 0.0032; ±0.02 is
  // ~6σ slack, more than enough for a non-flaky test.
  let sum = 0, count = 0;
  for (let n = 0; n < 1000; n++) {
    const xs = fair.floatsFrom('demo-seed', 'demo-client', n, 8);
    for (const x of xs) { sum += x; count++; }
  }
  const mean = sum / count;
  assert.ok(Math.abs(mean - 0.5) < 0.02, `mean ${mean} too far from 0.5`);
});

test('sha256Hex matches stdlib crypto', () => {
  const expected = crypto.createHash('sha256').update('hello').digest('hex');
  assert.equal(fair.sha256Hex('hello'), expected);
});
