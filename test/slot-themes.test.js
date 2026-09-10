'use strict';

// Every reel theme runs through one engine (playSlotsThemed) with pays solved
// by buildSlotTable, so the thing worth locking is the MATH: each theme must
// return the house RTP, and the numbers the UI shows must be the numbers the
// server actually pays.
//
// That second half is not hypothetical: Cosmic Reels advertised "190x" in the
// lobby tag and its own Top Prize stat while its table topped out at 115.50x.

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../server/games/core');
const { slotThemeInfo } = require('../server/games');

const THEMES = Object.keys(core.SLOT_THEMES);
const TARGET_RTP = 0.96;          // buildSlotTable solves to a 4% house edge
const TOL = 0.005;

// Exact expected return per spin, summed over the outcome space rather than
// sampled — no RNG, so no flake.
function exactRtp(theme) {
  const N = theme.symbols.length;
  const total = N ** 3;
  let ev = 0;
  for (let a = 0; a < N; a++) {
    for (let b = 0; b < N; b++) {
      for (let c = 0; c < N; c++) {
        if (a === b && b === c) ev += theme.triple[a];
        else if (a === b || b === c || a === c) ev += theme.pairPay;
      }
    }
  }
  return ev / total;
}

test('every slot theme returns the house RTP', () => {
  assert.ok(THEMES.length >= 7, 'themes are registered: ' + THEMES.join(', '));
  for (const key of THEMES) {
    const rtp = exactRtp(core.SLOT_THEMES[key]);
    assert.ok(Math.abs(rtp - TARGET_RTP) < TOL,
      `${key} RTP ${rtp.toFixed(4)} should be ~${TARGET_RTP}`);
  }
});

test('pay tables are well formed and rise with rarity', () => {
  for (const key of THEMES) {
    const t = core.SLOT_THEMES[key];
    assert.equal(t.triple.length, t.symbols.length, `${key}: a pay per symbol`);
    for (const p of t.triple) assert.ok(p > 0 && Number.isFinite(p), `${key}: finite positive pays`);
    // weights ascend, so pays must ascend too — the rarest symbol pays most.
    for (let i = 1; i < t.triple.length; i++) {
      assert.ok(t.triple[i] > t.triple[i - 1], `${key}: pay rises with rarity at ${t.symbols[i]}`);
    }
    assert.ok(t.pairPay > 0 && t.pairPay < 1, `${key}: a pair returns part of the stake`);
  }
});

test('published paytable matches what the engine pays', () => {
  const info = slotThemeInfo();
  for (const key of THEMES) {
    const t = core.SLOT_THEMES[key];
    assert.ok(info[key], `${key} is published`);
    assert.deepEqual(info[key].triple, t.triple, `${key}: published pays are the real pays`);
    assert.equal(info[key].pairPay, t.pairPay, `${key}: published pair pay is real`);
    assert.equal(info[key].top, Math.max(...t.triple), `${key}: published top prize is the real maximum`);
    assert.deepEqual(info[key].symbols, t.symbols, `${key}: published symbols are the real symbols`);
  }
});

test('the new themes really do play differently, not just look different', () => {
  const info = slotThemeInfo();
  // Volatility spread: the grindy reel and the wild one must not be the same game.
  assert.ok(info.frost.pairPay > info.dragon.pairPay,
    'Frozen Peaks pays pairs more often than Dragon\'s Gold');
  assert.ok(info.dragon.top > info.frost.top * 3,
    `Dragon's Gold peak (${info.dragon.top}) dwarfs Frozen Peaks (${info.frost.top})`);
  assert.ok(info.pirate.pairPay > info.crypt.pairPay, 'Pirate\'s Hoard is the friendlier of the two');
});
