'use strict';

// Unit tests for the new games' pure logic — mainly the Three Card Poker
// evaluator (the most bug-prone piece), plus the chicken multiplier curve
// and bingo line table shape.

const test = require('node:test');
const assert = require('node:assert/strict');

// The evaluator isn't exported directly, so re-require games and reach the
// functions through a tiny eval harness: games.js exposes tcpStart/tcpAct
// only. Simplest honest approach — re-implement the *checks* against the
// module by round-tripping through its exported helpers where possible, and
// for tcp use the internal evaluator via a require cache hack: instead, we
// import the module source and eval the two pure functions in isolation.
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'games.js'), 'utf8');

// Extract tcpOrder/tcpEvaluate/tcpCompare/tcpDealerQualifies + their constant.
function extract(names) {
  const sandbox = {};
  const start = src.indexOf('const TCP_RANKING');
  const end = src.indexOf('function tcpStart');
  assert.ok(start > 0 && end > start, 'tcp block found in games.js');
  const block = src.slice(start, end);
  // eslint-disable-next-line no-new-func
  new Function('exportsObj', block + '\n' + names.map(n => `exportsObj.${n} = ${n};`).join('\n'))(sandbox);
  return sandbox;
}
const { tcpEvaluate, tcpCompare, tcpDealerQualifies } = extract(['tcpEvaluate', 'tcpCompare', 'tcpDealerQualifies']);

const C = (rank, suit = 0) => ({ rank, suit });

test('tcp: hand kinds classified correctly', () => {
  assert.equal(tcpEvaluate([C(5, 1), C(6, 1), C(7, 1)]).kind, 'straightFlush');
  assert.equal(tcpEvaluate([C(9, 0), C(9, 1), C(9, 2)]).kind, 'trips');
  assert.equal(tcpEvaluate([C(5, 0), C(6, 1), C(7, 2)]).kind, 'straight');
  assert.equal(tcpEvaluate([C(2, 3), C(9, 3), C(13, 3)]).kind, 'flush');
  assert.equal(tcpEvaluate([C(4, 0), C(4, 1), C(11, 2)]).kind, 'pair');
  assert.equal(tcpEvaluate([C(2, 0), C(7, 1), C(12, 2)]).kind, 'high');
});

test('tcp: ace plays high in Q-K-A and low in A-2-3', () => {
  const high = tcpEvaluate([C(12, 0), C(13, 1), C(1, 2)]);   // Q K A
  assert.equal(high.kind, 'straight');
  assert.equal(high.kickers[0], 14, 'A-high straight ranks by 14');
  const low = tcpEvaluate([C(1, 0), C(2, 1), C(3, 2)]);      // A 2 3
  assert.equal(low.kind, 'straight');
  assert.equal(low.kickers[0], 3, 'A-2-3 is a 3-high straight');
  assert.ok(tcpCompare(high, low) > 0, 'AKQ beats A23');
});

test('tcp: 2-3-4 straight beats A-2-3 straight (ace low)', () => {
  const a23 = tcpEvaluate([C(1, 0), C(2, 1), C(3, 2)]);
  const s234 = tcpEvaluate([C(2, 0), C(3, 1), C(4, 2)]);
  assert.ok(tcpCompare(s234, a23) > 0);
});

test('tcp: pair compares by pair rank then kicker', () => {
  const nines = tcpEvaluate([C(9, 0), C(9, 1), C(2, 2)]);
  const fours = tcpEvaluate([C(4, 0), C(4, 1), C(13, 2)]);
  assert.ok(tcpCompare(nines, fours) > 0, 'pair of 9s beats pair of 4s despite kicker');
  const ninesAce = tcpEvaluate([C(9, 2), C(9, 3), C(1, 0)]);
  assert.ok(tcpCompare(ninesAce, nines) > 0, 'same pair, ace kicker wins');
});

test('tcp: aces pair beats kings pair (ace-order in pairs)', () => {
  const aces = tcpEvaluate([C(1, 0), C(1, 1), C(5, 2)]);
  const kings = tcpEvaluate([C(13, 0), C(13, 1), C(12, 2)]);
  assert.equal(aces.kind, 'pair');
  assert.ok(tcpCompare(aces, kings) > 0);
});

test('tcp: dealer qualification boundary (Q-high yes, J-high no)', () => {
  assert.equal(tcpDealerQualifies(tcpEvaluate([C(12, 0), C(7, 1), C(2, 2)])), true,  'Q-high qualifies');
  assert.equal(tcpDealerQualifies(tcpEvaluate([C(11, 0), C(7, 1), C(2, 2)])), false, 'J-high does not');
  assert.equal(tcpDealerQualifies(tcpEvaluate([C(2, 0), C(2, 1), C(3, 2)])),  true,  'any pair qualifies');
});

test('tcp: identical ranks push', () => {
  const a = tcpEvaluate([C(10, 0), C(7, 1), C(2, 2)]);
  const b = tcpEvaluate([C(10, 3), C(7, 2), C(2, 0)]);
  assert.equal(tcpCompare(a, b), 0);
});

test('chicken: multiplier curve is (1-house)/p^n', () => {
  const s2 = src.indexOf('const CHICKEN'), e2 = src.indexOf('function chickenStart');
  const sandbox = {};
  new Function('exportsObj', 'const HOUSE = 0.01;\n' + src.slice(s2, e2) + '\nexportsObj.chickenMult = chickenMult; exportsObj.CHICKEN = CHICKEN;')(sandbox);
  const { chickenMult, CHICKEN } = sandbox;
  assert.equal(chickenMult(0.5, 1), 1.98);
  // Every difficulty's first-step EV is exactly 1-HOUSE.
  for (const cfg of Object.values(CHICKEN)) {
    const ev = cfg.p * chickenMult(cfg.p, 1);
    assert.ok(Math.abs(ev - 0.99) < 0.001, `EV ${ev} for p=${cfg.p}`);
  }
});

test('bingo: 12 lines, payouts monotonically increasing', () => {
  const s3 = src.indexOf('const BINGO_DRAWS'), e3 = src.indexOf('function playBingo');
  const sandbox = {};
  new Function('exportsObj', src.slice(s3, e3) + '\nexportsObj.BINGO_LINES = BINGO_LINES; exportsObj.BINGO_PAYS = BINGO_PAYS;')(sandbox);
  assert.equal(sandbox.BINGO_LINES.length, 12);
  const p = sandbox.BINGO_PAYS;
  assert.ok(p[1] < p[2] && p[2] < p[3] && p[3] < p[4] && p[4] < p.max);
});
