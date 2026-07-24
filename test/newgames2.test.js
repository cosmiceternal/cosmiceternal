'use strict';

// RTP math for games batch 4 (Piñata Pop, Fan Tan, Red Dog). Extracts the
// payout constants/helpers straight from server/games.js and re-derives the
// return-to-player so a future edit that breaks the edge fails loudly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readdirSync(path.join(__dirname, '..', 'server', 'games')).filter(f => f.endsWith('.js')).sort().map(f => fs.readFileSync(path.join(__dirname, '..', 'server', 'games', f), 'utf8')).join('\n');

function extract(startMarker, endMarker, exportNames) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `block ${startMarker} found`);
  const sandbox = {};
  const body = src.slice(start, end);
  new Function('X', body + '\n' + exportNames.map(n => `X.${n} = ${n};`).join('\n'))(sandbox);
  return sandbox;
}

test('piñata pop: weighted multiplier table returns ~96%', () => {
  const ex = extract('const PINATA_MULTS', 'function playPinata', ['PINATA_MULTS', 'PINATA_W', 'pinataPick']);
  // Weights are a valid distribution.
  const total = ex.PINATA_W.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `weights sum to 1 (${total})`);
  // Analytic EV from the table.
  const ev = ex.PINATA_MULTS.reduce((a, m, i) => a + m * ex.PINATA_W[i], 0);
  assert.ok(ev > 0.95 && ev < 0.97, `pinata analytic RTP ${ev}`);
  // Monte Carlo through the actual pick function agrees.
  let p = 0, N = 300000;
  for (let i = 0; i < N; i++) p += ex.PINATA_MULTS[ex.pinataPick(Math.random())];
  assert.ok(p / N > 0.94 && p / N < 0.98, `pinata MC RTP ${p / N}`);
});

test('fan tan: remainder 1–4 pays 3.85× → 96.25%', () => {
  assert.ok(src.includes('FANTAN_MULT = 3.85'), 'fan tan pays 3.85×');
  const rtp = 3.85 / 4; // uniform remainder, one winning pick of four
  assert.ok(rtp > 0.95 && rtp < 0.97, `fan tan RTP ${rtp}`);
});

test('red dog: spread payouts return ~96% (Monte Carlo)', () => {
  const ex = extract('const REDDOG_PAY', 'function playRedDog', ['REDDOG_PAY', 'reddogSpreadPay', 'reddogResolve']);
  let ret = 0, N = 500000;
  for (let i = 0; i < N; i++) {
    const r = ex.reddogResolve([Math.random(), Math.random(), Math.random()]);
    // mult (total return): push → 1, win → profit+1, lose → 0.
    ret += r.push ? 1 : (r.profit > 0 ? r.profit + 1 : 0);
  }
  const rtp = ret / N;
  assert.ok(rtp > 0.95 && rtp < 0.975, `red dog RTP ${rtp}`);
});
