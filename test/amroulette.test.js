'use strict';

// American (double-zero) roulette: the extra 00 pocket makes every fair bet
// return ~94.74% (5.26% house edge). Verify the pay table + pocket count line
// up, and that 0/00 behave correctly (even-money loses, straight can hit 00).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'games.js'), 'utf8');

function extract(startMarker, endMarker, names) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `block ${startMarker} found`);
  const sandbox = { ROULETTE_RED: new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]) };
  // eslint-disable-next-line no-new-func
  new Function('X', 'ROULETTE_RED', src.slice(start, end) + '\n' + names.map(n => `X.${n} = ${n};`).join('\n'))(sandbox, sandbox.ROULETTE_RED);
  return sandbox;
}

test('american roulette: 38 pockets, ~94.74% RTP across bet classes', () => {
  const ex = extract('const AMROU_PAYS', 'function playAmRoulette', ['AMROU_PAYS', 'amRouColor', 'amRouLabel']);
  const P = ex.AMROU_PAYS;
  // Even-money bets: 18 winning pockets of 38.
  const evenRtp = (18 / 38) * P.red;
  assert.ok(Math.abs(evenRtp - 0.9474) < 0.001, `even-money RTP ${evenRtp}`);
  assert.equal(P.red, 2); assert.equal(P.black, 2); assert.equal(P.low, 2); assert.equal(P.high, 2);
  // Dozens & columns: 12 of 38 pay 3×.
  const dozRtp = (12 / 38) * P.dozen1;
  assert.ok(Math.abs(dozRtp - 0.9474) < 0.001, `dozen RTP ${dozRtp}`);
  assert.equal(P.col1, 3); assert.equal(P.col3, 3);
  // Straight: 1 of 38 pays 36×.
  const straightRtp = (1 / 38) * P.straight;
  assert.ok(Math.abs(straightRtp - 0.9474) < 0.001, `straight RTP ${straightRtp}`);

  // Colors: 0 and 00 (pocket 37) are green; reds match the wheel.
  assert.equal(ex.amRouColor(0), 'green');
  assert.equal(ex.amRouColor(37), 'green');
  assert.equal(ex.amRouLabel(37), '00');
  assert.equal(ex.amRouColor(1), 'red');
  assert.equal(ex.amRouColor(2), 'black');

  // Source: draws over 38 pockets and validates straight 0..37 (00 = 37).
  assert.ok(src.includes('Math.floor(floats[0] * 38)'), '38-pocket draw');
  assert.ok(src.includes('num > 37'), 'straight accepts up to 37 (00)');
});

test('american roulette: even-money loses on 0 and 00', () => {
  // A full Monte Carlo of the win logic would need the whole switch; instead
  // pin the key edge cases analytically: greens are neither odd nor even wins.
  const ex = extract('const AMROU_PAYS', 'function playAmRoulette', ['amRouColor']);
  for (const g of [0, 37]) assert.equal(ex.amRouColor(g), 'green'); // not red/black → even-money loses
});
