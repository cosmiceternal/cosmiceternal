'use strict';

// Let It Ride's payout table is solved, not copied. The casino-standard table
// (1000/200/50/11/8/5/3/2/1) only reaches its advertised ~3.5% edge under
// optimal pull-back play — a player who lets all three bets ride faces 37%.
// Every other game here has a flat edge whatever the player does, so this table
// is tuned to put always-riding in the same band.
//
// Checked exhaustively over all C(52,5) = 2,598,960 hands: no RNG, no sampling,
// no flake.

const test = require('node:test');
const assert = require('node:assert/strict');
const { lirEvaluate, LIR_PAYS } = require('../server/games');

function everyHand() {
  const deck = [];
  for (let s = 0; s < 4; s++) for (let r = 1; r <= 13; r++) deck.push({ suit: s, rank: r });
  const tally = {};
  let n = 0;
  for (let a = 0; a < 48; a++) {
    for (let b = a + 1; b < 49; b++) {
      for (let c = b + 1; c < 50; c++) {
        for (let d = c + 1; d < 51; d++) {
          for (let e = d + 1; e < 52; e++) {
            const k = lirEvaluate([deck[a], deck[b], deck[c], deck[d], deck[e]]);
            tally[k] = (tally[k] || 0) + 1;
            n++;
          }
        }
      }
    }
  }
  return { tally, n };
}

const { tally, n } = everyHand();

test('every five-card hand lands in exactly one paying category', () => {
  assert.equal(n, 2598960, 'the whole space was walked');
  const known = Object.keys(LIR_PAYS);
  for (const k of Object.keys(tally)) assert.ok(known.includes(k), `${k} has a payout`);
  assert.equal(Object.values(tally).reduce((a, b) => a + b, 0), n, 'every hand counted once');
});

test('the published hand frequencies are the real ones', () => {
  // Textbook five-card frequencies — a check that the evaluator is correct,
  // independent of the payouts.
  assert.equal(tally.royal, 4);
  assert.equal(tally.sf, 36);               // straight flushes excluding royals
  assert.equal(tally.four, 624);
  assert.equal(tally.full, 3744);
  assert.equal(tally.flush, 5108);          // flushes excluding straight flushes
  assert.equal(tally.straight, 10200);      // straights excluding straight flushes
  assert.equal(tally.three, 54912);
  assert.equal(tally.twopair, 123552);
});

test('a bet that rides the whole way faces a house edge in the floor band', () => {
  let ev = 0;
  for (const [kind, count] of Object.entries(tally)) {
    const p = count / n;
    const pay = LIR_PAYS[kind];
    ev += p * (pay > 0 ? pay : -1);         // losers forfeit the bet
  }
  const edge = -ev;
  assert.ok(edge > 0, `the house must hold an edge, got ${(edge * 100).toFixed(2)}%`);
  assert.ok(edge < 0.05, `edge ${(edge * 100).toFixed(2)}% should sit under 5% like the rest of the floor`);
  assert.ok(Math.abs(edge - 0.0338) < 0.002, `edge should be ~3.38%, got ${(edge * 100).toFixed(2)}%`);
});

test('pays rise with rarity', () => {
  const order = ['tens', 'twopair', 'three', 'straight', 'flush', 'full', 'four', 'sf', 'royal'];
  for (let i = 1; i < order.length; i++) {
    assert.ok(LIR_PAYS[order[i]] > LIR_PAYS[order[i - 1]],
      `${order[i]} pays more than ${order[i - 1]}`);
    assert.ok(tally[order[i]] <= tally[order[i - 1]],
      `${order[i]} is no more common than ${order[i - 1]}`);
  }
});

test('tens or better — not jacks — is what qualifies', () => {
  const C = (suit, rank) => ({ suit, rank });
  const tens = [C(0, 10), C(1, 10), C(2, 3), C(3, 5), C(0, 7)];
  assert.equal(lirEvaluate(tens), 'tens', 'a pair of tens pays');
  const nines = [C(0, 9), C(1, 9), C(2, 3), C(3, 5), C(0, 7)];
  assert.equal(lirEvaluate(nines), 'none', 'a pair of nines does not');
  const aces = [C(0, 1), C(1, 1), C(2, 3), C(3, 5), C(0, 7)];
  assert.equal(lirEvaluate(aces), 'tens', 'aces qualify (stored as rank 1)');
});
