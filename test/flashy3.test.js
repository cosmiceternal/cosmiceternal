'use strict';

// Math tests for flashy batch 3. Extract the constants/helpers from games.js
// and re-derive the RTP so a future edit that breaks the edge fails loudly.

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
  new Function('X', body + '\n' + exportNames.map(n => `X.${n} = ${n};`).join('\n'))(sandbox);
  return sandbox;
}

test('mini roulette: even-money with la partage ~96%, straight ~96%', () => {
  // Analytic: 13 pockets. Even-money win 6/13 → 2×, plus 0 (1/13) → 0.5× back.
  const evenRtp = (6 / 13) * 2 + (1 / 13) * 0.5;
  assert.ok(evenRtp > 0.95 && evenRtp < 0.97, `even-money RTP ${evenRtp}`);
  const straightRtp = (1 / 13) * 12.5;
  assert.ok(straightRtp > 0.95 && straightRtp < 0.97, `straight RTP ${straightRtp}`);
  // Confirm the constants in the source match.
  assert.ok(src.includes('mult = 12.5'), 'straight pays 12.5x');
  assert.ok(src.includes('mult = 0.5; laPartage'), 'la partage returns half');
});

test('slingo: 10-spin Monte Carlo RTP in [0.93, 0.99]', () => {
  const ex = extract('const SLINGO_SPINS', 'function playSlingo',
    ['SLINGO_SPINS', 'SLINGO_LINES', 'SLINGO_PAY']);
  assert.equal(ex.SLINGO_SPINS, 10);
  assert.equal(ex.SLINGO_LINES.length, 12);
  assert.equal(ex.SLINGO_PAY[12], 5000);
  // Re-run the exact marking model.
  function play() {
    const marked = new Array(25).fill(false);
    const u = [5, 5, 5, 5, 5];
    for (let s = 0; s < ex.SLINGO_SPINS; s++) for (let c = 0; c < 5; c++) {
      if (u[c] === 0) continue;
      if (Math.random() * 15 < u[c]) {
        const cells = []; for (let r = 0; r < 5; r++) { const i = r * 5 + c; if (!marked[i]) cells.push(i); }
        marked[cells[Math.floor(Math.random() * cells.length)]] = true; u[c]--;
      }
    }
    let l = 0; for (const L of ex.SLINGO_LINES) if (L.every(i => marked[i])) l++;
    return ex.SLINGO_PAY[l];
  }
  let w = 0, p = 0;
  for (let t = 0; t < 400000; t++) { p += play(); w += 1; }
  const rtp = p / w;
  assert.ok(rtp > 0.93 && rtp < 0.99, `slingo RTP ${rtp}`);
});

test("zeus's gates: pay-anywhere + tumble + orbs RTP in [0.92, 1.0]", () => {
  const ex = extract("const GATES_COLS", 'function playZeusGates',
    ['GATES_CELLS', 'GATES_SYMS', 'GATES_W', 'GATES_SCALE', 'GATES_ORB_RATE', 'GATES_ORBS', 'gatesSym', 'gatesOrb', 'gatesPayFor']);
  assert.equal(ex.GATES_CELLS, 30);
  // Full-engine Monte Carlo.
  function spin() {
    const grid = new Array(ex.GATES_CELLS); const orbs = [];
    for (let i = 0; i < ex.GATES_CELLS; i++) { if (Math.random() < ex.GATES_ORB_RATE) { grid[i] = -1; orbs.push(ex.gatesOrb(Math.random())); } else grid[i] = ex.gatesSym(Math.random()); }
    let base = 0, guard = 0;
    while (guard++ < 30) {
      const counts = new Array(ex.GATES_SYMS).fill(0);
      for (let i = 0; i < ex.GATES_CELLS; i++) if (grid[i] >= 0) counts[grid[i]]++;
      let any = false;
      for (let s = 0; s < ex.GATES_SYMS; s++) { const p = ex.gatesPayFor(s, counts[s]); if (p > 0) { base += p; any = true; for (let i = 0; i < ex.GATES_CELLS; i++) if (grid[i] === s) grid[i] = -2; } }
      if (!any) break;
      for (let i = 0; i < ex.GATES_CELLS; i++) if (grid[i] === -2) { if (Math.random() < ex.GATES_ORB_RATE) { grid[i] = -1; orbs.push(ex.gatesOrb(Math.random())); } else grid[i] = ex.gatesSym(Math.random()); }
    }
    const orbMult = orbs.reduce((a, b) => a + b, 0);
    return (base > 0 && orbMult > 0) ? base * orbMult : base;
  }
  let w = 0, p = 0;
  for (let t = 0; t < 150000; t++) { p += spin(); w += 1; }
  const rtp = p / w;
  assert.ok(rtp > 0.92 && rtp < 1.0, `zeus gates RTP ${rtp}`);
});
