'use strict';

// Every integration test spawns its own server on `BASE + (process.pid % 100)`.
// Two files sharing a BASE collide whenever their pids happen to match modulo
// 100 — about a 1% chance per pair, per run. That is invisible locally and
// shows up as a mystifying "server did not start" on CI; three such duplicate
// bases were exactly what turned main red twice.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('every test file uses a unique server port base', () => {
  const dir = __dirname;
  const bases = new Map(); // base -> [files]
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.test.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const m = src.match(/const PORT = (\d+) \+ \(process\.pid % 100\)/);
    if (!m) continue;
    const base = Number(m[1]);
    if (!bases.has(base)) bases.set(base, []);
    bases.get(base).push(f);
  }
  assert.ok(bases.size > 0, 'found port bases to check');

  const clashes = [...bases.entries()].filter(([, files]) => files.length > 1);
  assert.deepEqual(clashes, [],
    'these files share a port base and will intermittently fail to bind:\n' +
    clashes.map(([b, files]) => `  ${b}: ${files.join(', ')}`).join('\n'));

  // Bases must also be at least 100 apart, since each file spans base..base+99.
  const sorted = [...bases.keys()].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i] - sorted[i - 1] >= 100,
      `port ranges overlap: ${sorted[i - 1]} and ${sorted[i]} are less than 100 apart`);
  }
});
