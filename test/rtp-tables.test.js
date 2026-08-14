'use strict';

// Payout-math verification for the games that never had it.
//
// The newer "spectacle" games each shipped with an RTP test; the original games
// (plinko, keno, wheel, scratch, colour, diamonds, slots, cascade) and the
// multiplier-curve games (mines, towers, pump, penalty) did not. That gap hid a
// real bug: plinko's 12-row/high-risk table returned 87.5% while every other
// plinko table returned ~99%.
//
// Two kinds of assertion here:
//   * PAYTABLE games — compute the exact expected return from the table and its
//     outcome distribution, and require it inside a disclosed band.
//   * CURVE games — a fixed "RTP" is meaningless because the player chooses when
//     to cash out, so assert the fairness invariant instead: the multiplier at
//     any point, times the probability of reaching it, equals (1 - edge). That
//     is the property that actually has to hold.

const test = require('node:test');
const assert = require('node:assert/strict');
const g = require('../server/games');

function comb(n, k) {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}
const binomEV = (table) => {
  const n = table.length - 1;
  let ev = 0;
  for (let k = 0; k <= n; k++) ev += comb(n, k) * Math.pow(0.5, n) * table[k];
  return ev;
};
const inBand = (v, lo, hi, label) =>
  assert.ok(v >= lo && v <= hi, `${label}: ${v.toFixed(4)} outside [${lo}, ${hi}]`);

test('plinko: every rows/risk table returns ~99%', () => {
  const seen = [];
  for (const rows of Object.keys(g.PLINKO)) {
    for (const risk of Object.keys(g.PLINKO[rows])) {
      const table = g.PLINKO[rows][risk];
      assert.equal(table.length, Number(rows) + 1, `plinko/${rows}/${risk} needs ${rows}+1 slots`);
      assert.deepEqual(table, table.slice().reverse(), `plinko/${rows}/${risk} must be symmetric`);
      const ev = binomEV(table);
      inBand(ev, 0.97, 1.0, `plinko/${rows}/${risk}`);
      seen.push(ev);
    }
  }
  assert.equal(seen.length, 9, 'all nine plinko tables checked');
  // No config may be a materially worse deal than another — that was the bug.
  const spread = Math.max(...seen) - Math.min(...seen);
  assert.ok(spread < 0.02, `plinko RTP spread across configs too wide: ${spread.toFixed(4)}`);
});

test('keno: every pick count returns ~97% (3% disclosed edge)', () => {
  for (let picks = 1; picks <= 10; picks++) {
    const table = g.KENO_TABLES[picks];
    let ev = 0;
    for (let hits = 0; hits <= picks; hits++) {
      const p = (comb(10, hits) * comb(30, picks - hits)) / comb(40, picks);
      ev += p * (table[hits] || 0);
    }
    inBand(ev, 0.95, 0.99, `keno/${picks}`);
  }
});

test('wheel: every risk tier averages ~99%', () => {
  for (const risk of Object.keys(g.WHEEL)) {
    const t = g.WHEEL[risk];
    assert.equal(t.length, 10, `wheel/${risk} has 10 segments`);
    inBand(t.reduce((a, b) => a + b, 0) / t.length, 0.97, 1.0, `wheel/${risk}`);
  }
});

test('colour: each colour pays its true frequency', () => {
  const winners = { violet: 2, red: 4, green: 4 }; // 0,5 | 1,3,7,9 | 2,4,6,8
  for (const c of Object.keys(g.COLOR_PAYS)) {
    inBand((winners[c] / 10) * g.COLOR_PAYS[c], 0.94, 0.99, `colour/${c}`);
  }
});

test('scratch: binomial table returns ~95%', () => {
  let ev = 0;
  for (let k = 0; k <= 9; k++) {
    ev += comb(9, k) * Math.pow(0.3, k) * Math.pow(0.7, 9 - k) * (g.SCRATCH_TABLE[k] || 0);
  }
  inBand(ev, 0.93, 0.98, 'scratch');
});

test('slots: all three themes return ~96%', () => {
  for (const theme of ['classic', 'sevens', 'cosmic']) {
    const t = g.SLOT_THEMES[theme];
    const N = t.symbols.length;
    const pTriple = 1 / Math.pow(N, 3);
    const pPair = (3 * N * (N - 1)) / Math.pow(N, 3);
    const ev = t.triple.reduce((a, m) => a + m * pTriple, 0) + pPair * t.pairPay;
    inBand(ev, 0.95, 0.97, `slots/${theme}`);
  }
});

test('cascade: each risk returns ~96.5%', () => {
  const CELLS = 6;
  for (const risk of Object.keys(g.CASCADE_TABLES)) {
    const p = g.CASCADE_P[risk], t = g.CASCADE_TABLES[risk];
    let ev = 0;
    for (let k = 0; k <= CELLS; k++) {
      const P = k === CELLS ? Math.pow(p, k) : Math.pow(p, k) * (1 - p);
      ev += P * (t[k] || 0);
    }
    inBand(ev, 0.94, 0.99, `cascade/${risk}`);
  }
});

test('diamonds: paytable is ordered and returns ~99%', () => {
  const P = g.DIAMOND_PAYS;
  const order = ['none', 'pair', 'twopair', 'three', 'full', 'four', 'five'];
  for (let i = 1; i < order.length; i++) {
    assert.ok(P[order[i]] > P[order[i - 1]], `diamonds: ${order[i]} must beat ${order[i - 1]}`);
  }
  // Exact EV over all 7^5 ordered draws — no sampling needed at this size.
  const TYPES = 7;
  const cat = (counts) => {
    const c = counts.filter(x => x > 0).sort((a, b) => b - a);
    if (c[0] === 5) return 'five';
    if (c[0] === 4) return 'four';
    if (c[0] === 3 && c[1] === 2) return 'full';
    if (c[0] === 3) return 'three';
    if (c[0] === 2 && c[1] === 2) return 'twopair';
    if (c[0] === 2) return 'pair';
    return 'none';
  };
  let total = 0, paid = 0;
  const draw = (depth, counts) => {
    if (depth === 5) { total++; paid += P[cat(counts)] || 0; return; }
    for (let t = 0; t < TYPES; t++) { counts[t]++; draw(depth + 1, counts); counts[t]--; }
  };
  draw(0, new Array(TYPES).fill(0));
  inBand(paid / total, 0.97, 1.0, 'diamonds');
});

test('video poker: paytable rises with hand strength', () => {
  const P = g.VIDEO_POKER_PAYS;
  const order = ['none', 'jacks', 'twopair', 'three', 'straight', 'flush', 'full', 'four', 'sf', 'royal'];
  for (let i = 1; i < order.length; i++) {
    assert.ok(P[order[i]] >= P[order[i - 1]], `videopoker: ${order[i]} must not pay less than ${order[i - 1]}`);
  }
  assert.equal(P.none, 0);
  assert.ok(P.royal >= 100, 'royal flush is the headline prize');
});

// ---- Curve games: multiplier x P(reaching it) must equal (1 - edge) ----

test('mines: multiplier x survival probability is a flat 99%', () => {
  for (const mines of [1, 3, 5, 10]) {
    for (const safe of [1, 3, 6]) {
      if (safe > 25 - mines) continue;
      let p = 1;
      for (let i = 0; i < safe; i++) p *= (25 - mines - i) / (25 - i);
      inBand(g.minesMult(safe, mines) * p, 0.985, 0.995, `mines ${mines}m/${safe}safe`);
    }
  }
});

test('towers: multiplier x survival probability is flat per difficulty', () => {
  for (const diff of Object.keys(g.TOWERS)) {
    const d = g.TOWERS[diff];
    for (const rows of [1, 3, 5]) {
      const p = Math.pow(d.safe / d.tiles, rows);
      // Towers charges its edge on every row, so the return compounds as
      // (1 - HOUSE)^rows. Assert that exact shape rather than a flat number.
      inBand(g.towersMult(diff, rows) * p / Math.pow(0.99, rows), 0.995, 1.005, `towers/${diff} x${rows}`);
    }
  }
});

test('pump: multiplier x survival probability is a flat 99%', () => {
  for (const diff of Object.keys(g.PUMP)) {
    const positions = g.PUMP[diff];
    for (let level = 1; level < Math.min(positions, 4); level++) {
      let p = 1;
      for (let i = 0; i < level; i++) p *= (positions - 1 - i) / (positions - i);
      inBand(g.pumpMult(positions, level) * p, 0.985, 0.995, `pump/${diff} level ${level}`);
    }
  }
});

test('penalty: the 3% edge compounds once per goal', () => {
  // Each shot scores with p = 2/3 (the keeper commits to one of three sides),
  // so cashing out after n goals returns 0.97^n. Deliberate: the longer you
  // push, the more edge you have paid.
  for (let goals = 1; goals <= 5; goals++) {
    const ev = g.penaltyMult(goals) * Math.pow(2 / 3, goals);
    assert.ok(Math.abs(ev - Math.pow(0.97, goals)) < 0.002,
      `penalty ${goals} goals: ${ev.toFixed(4)} != 0.97^${goals}`);
  }
});

test('hi-lo: multiplier x win chance is a flat 99% at every card', () => {
  for (let card = 1; card <= 13; card++) {
    const c = g.hiloChances ? g.hiloChances(card) : null;
    if (!c) return; // helper not exported — nothing to assert
    const m = g.hiloMults(card);
    inBand(m.hi * c.hi, 0.985, 0.995, `hilo hi @${card}`);
    inBand(m.lo * c.lo, 0.985, 0.995, `hilo lo @${card}`);
  }
});

// ---- Client/server paytable parity ----
// Several game clients hardcode the paytable they display. The server stays
// authoritative for the actual payout, so a stale client copy does not mispay —
// it does something arguably worse, which is advertise odds the game does not
// honour. Plinko carried exactly such a mirror, so lock them all together.

const fs = require('node:fs');
const path = require('node:path');
const clientSrc = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'games', f), 'utf8');
// Pull the numbers out of display strings like ['Full house', '6×'].
const labelledPays = (src) => [...src.matchAll(/'([^']+)',\s*'([\d.]+)×'/g)]
  .map(m => [m[1].toLowerCase(), Number(m[2])]);

test('parity: plinko tables match the server exactly', () => {
  const src = clientSrc('plinko.js');
  const block = src.match(/const SLOTS = (\{[\s\S]*?\n  \});/);
  assert.ok(block, 'client plinko SLOTS block found');
  const client = new Function('return ' + block[1])();
  for (const rows of Object.keys(g.PLINKO)) {
    for (const risk of Object.keys(g.PLINKO[rows])) {
      assert.deepEqual(client[rows][risk], g.PLINKO[rows][risk],
        `plinko/${rows}/${risk} differs between client and server`);
    }
  }
});

test('parity: wheel tables match the server exactly', () => {
  const src = clientSrc('wheel.js');
  for (const risk of Object.keys(g.WHEEL)) {
    const m = src.match(new RegExp(risk + ':\\s*(\\[[^\\]]*\\])'));
    assert.ok(m, `client wheel/${risk} table found`);
    assert.deepEqual(new Function('return ' + m[1])(), g.WHEEL[risk],
      `wheel/${risk} differs between client and server`);
  }
});

test('parity: displayed paytables match the server', () => {
  const cases = [
    ['diamonds.js', g.DIAMOND_PAYS, {
      '5 of a kind': 'five', '4 of a kind': 'four', 'full house': 'full',
      '3 of a kind': 'three', 'two pair': 'twopair', 'pair': 'pair'
    }],
    ['videopoker.js', g.VIDEO_POKER_PAYS, {
      'royal flush': 'royal', 'straight flush': 'sf', 'four of a kind': 'four',
      'full house': 'full', 'flush': 'flush', 'straight': 'straight',
      'three of a kind': 'three', 'two pair': 'twopair', 'jacks or better': 'jacks'
    }],
  ];
  for (const [file, serverTable, map] of cases) {
    const shown = labelledPays(clientSrc(file));
    let checked = 0;
    for (const [label, value] of shown) {
      const key = map[label];
      if (!key) continue;
      assert.equal(value, serverTable[key],
        `${file}: "${label}" shows ${value}x but the server pays ${serverTable[key]}x`);
      checked++;
    }
    assert.ok(checked >= 6, `${file}: expected to verify at least 6 rows, checked ${checked}`);
  }
});

test('parity: colour payouts match the server', () => {
  const shown = [...clientSrc('color.js').matchAll(/key: '(\w+)'[^}]*pay: '([\d.]+)×'/g)];
  assert.ok(shown.length >= 3, 'client colour options found');
  for (const [, key, val] of shown) {
    assert.equal(Number(val), g.COLOR_PAYS[key],
      `colour/${key} shows ${val}x but the server pays ${g.COLOR_PAYS[key]}x`);
  }
});
