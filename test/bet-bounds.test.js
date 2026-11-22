'use strict';

// The wager chokepoint (core.toCents) is the single place every game's stake
// passes through. It must reject anything that isn't a sane, in-range, positive
// integer number of cents BEFORE the value reaches the database — a non-finite
// or out-of-range stake bound into the debit UPDATE is a portability landmine
// (harmless on SQLite, a 500 on Postgres).

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../server/games/core');

const status = (fn) => { try { fn(); return 0; } catch (e) { return e.status || -1; } };

test('toCents accepts normal stakes', () => {
  assert.equal(core.toCents(1), 100);
  assert.equal(core.toCents('2.50'), 250);
  assert.equal(core.toCents(0.01), 1);
});

test('toCents rejects zero, negative and sub-cent stakes', () => {
  for (const bad of [0, -1, -0.5, 0.004, 0.0001]) {
    assert.equal(status(() => core.toCents(bad)), 400, `should 400 on ${bad}`);
  }
});

test('toCents rejects non-numeric and non-finite stakes', () => {
  for (const bad of [NaN, Infinity, -Infinity, 'abc', null, undefined, {}, '']) {
    assert.equal(status(() => core.toCents(bad)), 400, `should 400 on ${String(bad)}`);
  }
});

test('toCents rejects absurd finite stakes that overflow when scaled to cents', () => {
  // 1e308 is finite, but 1e308 * 100 is Infinity — exactly the value that must
  // never reach the driver. Also reject anything past the safe-integer range.
  for (const bad of [1e308, 1e300, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER]) {
    assert.equal(status(() => core.toCents(bad)), 400, `should 400 on ${bad}`);
  }
});

test('toCents accepts the largest still-sane stake', () => {
  // A big but safe-integer-cents stake is allowed through (the balance check,
  // not toCents, is what stops a player betting more than they hold).
  const cents = core.toCents(1_000_000);
  assert.equal(cents, 100_000_000);
  assert.ok(Number.isSafeInteger(cents));
});
