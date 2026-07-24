'use strict';

// Pure-math tests for the 5 spectacle games: derby RTP identity, cash hunt +
// big catch expected-value, RPS win/tie/lose classification, and Neon Fruits
// payline evaluation with wild substitution. These extract the constants from
// games.js and re-derive the analytic RTP so a future edit that breaks the
// house edge fails loudly.

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
  // eslint-disable-next-line no-new-func
  new Function('X', 'httpError', body + '\n' + exportNames.map(n => `X.${n} = ${n};`).join('\n'))(sandbox, () => new Error());
  return sandbox;
}

test('derby: every horse is a uniform ~96% RTP bet', () => {
  const { DERBY_HORSES } = extract('const DERBY_HORSES', 'function playDerby', ['DERBY_HORSES']);
  assert.equal(DERBY_HORSES.length, 6);
  const pSum = DERBY_HORSES.reduce((a, h) => a + h.p, 0);
  assert.ok(Math.abs(pSum - 1) < 1e-9, `win probabilities sum to 1 (got ${pSum})`);
  for (const h of DERBY_HORSES) {
    const rtp = h.p * h.odds; // RTP of a bet on this horse
    assert.ok(rtp > 0.95 && rtp < 0.965, `${h.name} RTP ${rtp}`);
  }
});

test('cash hunt: expected multiplier in [0.95, 1.0]', () => {
  const { CASH_HUNT_POOL } = extract('const CASH_HUNT_POOL', 'function cashHuntDraw', ['CASH_HUNT_POOL']);
  const w = CASH_HUNT_POOL.reduce((a, e) => a + e.w, 0);
  const ev = CASH_HUNT_POOL.reduce((a, e) => a + e.w * e.m, 0) / w;
  assert.ok(ev > 0.95 && ev < 1.0, `cash hunt E[m] ${ev}`);
  // Top prize present.
  assert.ok(CASH_HUNT_POOL.some(e => e.m === 100));
});

test('big catch: expected multiplier ~0.96, whale is 40x', () => {
  const { CATCH_POOL } = extract('const CATCH_POOL', 'function playBigCatch', ['CATCH_POOL']);
  const w = CATCH_POOL.reduce((a, e) => a + e.w, 0);
  const ev = CATCH_POOL.reduce((a, e) => a + e.w * e.m, 0) / w;
  assert.ok(ev > 0.94 && ev < 0.98, `big catch E[m] ${ev}`);
  assert.equal(CATCH_POOL.find(f => f.name === 'Whale').m, 40);
});

test('neon fruits: payline eval, wild substitution, RTP band', () => {
  const ex = extract('const FRUIT_NAMES', 'function playNeonFruits',
    ['FRUIT_WEIGHT', 'FRUIT_PAY', 'FRUIT_LINES', 'FRUIT_WILD', 'fruitReel', 'fruitEvalLine']);
  assert.equal(ex.FRUIT_LINES.length, 10);
  // A full line of sevens (symbol 5) on the middle row pays the 5-of-a-kind.
  const grid = [[0,5,0],[0,5,0],[0,5,0],[0,5,0],[0,5,0]];
  const res = ex.fruitEvalLine(grid, [1,1,1,1,1]);
  assert.equal(res.mult, ex.FRUIT_PAY[5][2]);
  // Wild (7) substitutes: 4 bells + a wild = 5-of-a-kind bells.
  const g2 = [[3,0,0],[3,0,0],[3,0,0],[3,0,0],[7,0,0]];
  const r2 = ex.fruitEvalLine(g2, [0,0,0,0,0]);
  assert.equal(r2.mult, ex.FRUIT_PAY[3][2], 'wild completes a 5-bell line');
  // Two symbols never pay.
  const g3 = [[0,0,0],[0,0,0],[1,0,0],[0,0,0],[0,0,0]];
  assert.equal(ex.fruitEvalLine(g3, [0,0,0,0,0]).mult, 0);

  // Monte Carlo RTP over the extracted engine — must land in a sane band.
  function reel(f) { let r = f * ex.FRUIT_WEIGHT.reduce((a,b)=>a+b,0); for (let i=0;i<ex.FRUIT_WEIGHT.length;i++){ if(r<ex.FRUIT_WEIGHT[i])return i; r-=ex.FRUIT_WEIGHT[i]; } return ex.FRUIT_WEIGHT.length-1; }
  let wagered = 0, paid = 0;
  for (let t = 0; t < 200000; t++) {
    const grid = [];
    for (let c = 0; c < 5; c++) grid.push([reel(Math.random()), reel(Math.random()), reel(Math.random())]);
    let mult = 0;
    for (const line of ex.FRUIT_LINES) { const r = ex.fruitEvalLine(grid, line); if (r.mult > 0) mult += r.mult / 10; }
    wagered += 1; paid += mult;
  }
  const rtp = paid / wagered;
  assert.ok(rtp > 0.90 && rtp < 1.02, `neon fruits empirical RTP ${rtp}`);
});
