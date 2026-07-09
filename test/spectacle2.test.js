'use strict';

// Pure-math tests for spectacle batch 2. Extract the constants/helpers from
// games.js and re-derive the analytic RTP so a future edit that breaks the
// house edge fails loudly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'games.js'), 'utf8');

function extract(startMarker, endMarker, exportNames) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `block ${startMarker} found`);
  const sandbox = {};
  const body = src.slice(start, end);
  // eslint-disable-next-line no-new-func
  new Function('X', body + '\n' + exportNames.map(n => `X.${n} = ${n};`).join('\n'))(sandbox);
  return sandbox;
}

test('mega wheel: 20 segments, E[m] in [0.93, 0.97]', () => {
  const { WHEEL_SEGMENTS } = extract('const WHEEL_SEGMENTS', 'function playMegaWheel', ['WHEEL_SEGMENTS']);
  assert.equal(WHEEL_SEGMENTS.length, 20);
  const ev = WHEEL_SEGMENTS.reduce((a, m) => a + m, 0) / WHEEL_SEGMENTS.length;
  assert.ok(ev > 0.93 && ev < 0.97, `wheel E[m] ${ev}`);
  assert.ok(WHEEL_SEGMENTS.includes(8), 'has the 8x jackpot segment');
});

test('ten pin: outcome distribution E[m] ~0.96', () => {
  const { TENPIN_TIERS } = extract('const TENPIN_TIERS', 'function playTenPin', ['TENPIN_TIERS']);
  const total = TENPIN_TIERS.reduce((a, t) => a + t.w, 0);
  const ev = TENPIN_TIERS.reduce((a, t) => a + (t.w / total) * t.m, 0);
  assert.ok(ev > 0.94 && ev < 0.98, `ten pin E[m] ${ev}`);
  // Strike tier pays 10x.
  assert.equal(TENPIN_TIERS.find(t => t.pins === 10).m, 10);
});

test('bullseye: 3-dart expected total ~0.96', () => {
  const { DART_RINGS } = extract('const DART_RINGS', 'function dartThrow', ['DART_RINGS']);
  const total = DART_RINGS.reduce((a, d) => a + d.w, 0);
  const perDart = DART_RINGS.reduce((a, d) => a + (d.w / total) * d.m, 0);
  const threeDart = perDart * 3;
  assert.ok(threeDart > 0.94 && threeDart < 0.98, `bullseye 3-dart E ${threeDart}`);
  assert.equal(DART_RINGS.find(d => d.ring === 'bull').m, 5);
});

test('firecracker: E[m] in [0.94, 1.0]', () => {
  const { FIRECRACKER_POOL } = extract('const FIRECRACKER_POOL', 'function playFirecracker', ['FIRECRACKER_POOL']);
  const total = FIRECRACKER_POOL.reduce((a, e) => a + e.w, 0);
  const ev = FIRECRACKER_POOL.reduce((a, e) => a + e.w * e.m, 0) / total;
  assert.ok(ev > 0.94 && ev < 1.0, `firecracker E[m] ${ev}`);
  assert.ok(FIRECRACKER_POOL.some(e => e.m === 100), 'has 100x');
});

test('sugar blast: cluster detection + tumbling RTP band', () => {
  const ex = extract('const SUGAR_COLS', 'function playSugarBlast',
    ['SUGAR_COLS', 'SUGAR_ROWS', 'SUGAR_SYMS', 'sugarPay', 'sugarClusters']);
  assert.equal(ex.SUGAR_COLS, 7);
  assert.equal(ex.SUGAR_ROWS, 6);
  // A vertical run of 5 same symbols in one column is a cluster.
  const g = [];
  for (let c = 0; c < 7; c++) { g.push([]); for (let r = 0; r < 6; r++) g[c].push(c === 0 && r < 5 ? 0 : (r + c + 1) % 6); }
  const cl = ex.sugarClusters(g);
  assert.ok(cl.some(c => c.length >= 5), 'detects the vertical 5-cluster');
  // Pay scales with size.
  assert.ok(ex.sugarPay(5) > 0 && ex.sugarPay(17) > ex.sugarPay(10));
  assert.equal(ex.sugarPay(4), 0, 'clusters under 5 pay nothing');

  // Monte Carlo the full tumble engine — must land in a sane band.
  function randSym() { return Math.floor(Math.random() * ex.SUGAR_SYMS); }
  function spin() {
    const grid = [];
    for (let c = 0; c < ex.SUGAR_COLS; c++) { grid.push([]); for (let r = 0; r < ex.SUGAR_ROWS; r++) grid[c].push(randSym()); }
    let win = 0, guard = 0;
    while (guard++ < 40) {
      const clusters = ex.sugarClusters(grid);
      if (!clusters.length) break;
      for (const cl2 of clusters) { win += ex.sugarPay(cl2.length); for (const [x, y] of cl2) grid[x][y] = -1; }
      for (let c = 0; c < ex.SUGAR_COLS; c++) {
        const kept = grid[c].filter(s => s >= 0);
        const fill = ex.SUGAR_ROWS - kept.length;
        const nc = []; for (let i = 0; i < fill; i++) nc.push(randSym());
        grid[c] = nc.concat(kept);
      }
    }
    return win;
  }
  let w = 0, p = 0;
  for (let t = 0; t < 120000; t++) { p += spin(); w += 1; }
  const rtp = p / w;
  assert.ok(rtp > 0.88 && rtp < 1.0, `sugar blast RTP ${rtp}`);
});
