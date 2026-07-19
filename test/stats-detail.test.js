'use strict';

// The player stats dashboard's detail endpoint: per-game breakdown + a daily
// cumulative-profit series. Guards the shape the client charts depend on.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const REPO = path.join(__dirname, '..');
const PORT = 6800 + (process.pid % 100);
const BASE = `http://localhost:${PORT}`;
const DB = `/tmp/crypt-test-statsdetail-${process.pid}.db`;

function rmDb() { for (const f of [DB, DB + '-shm', DB + '-wal']) { try { fs.unlinkSync(f); } catch (_) {} } }
function newSession() { return { csrf: '', jar: '' }; }
async function req(sess, method, p, body) {
  const headers = { Cookie: sess.jar };
  if (body) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && sess.csrf) headers['X-CSRF-Token'] = sess.csrf;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  for (const s of sc) {
    const [pair] = s.split(';'); const [k, ...v] = pair.split('='); const key = k.trim(), val = v.join('=');
    if (key === 'csrf') sess.csrf = val;
    const parts = sess.jar ? sess.jar.split('; ').filter(x => !x.startsWith(key + '=')) : [];
    parts.push(`${key}=${val}`); sess.jar = parts.join('; ');
  }
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}
function waitForReady(url, timeoutMs = 10_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try { const r = await fetch(url); if (r.ok) return resolve(); } catch (_) {}
      if (Date.now() - start > timeoutMs) return reject(new Error('server did not start'));
      setTimeout(tick, 150);
    };
    tick();
  });
}

test('stats detail: per-game breakdown + cumulative profit series', async () => {
  rmDb();
  const child = spawn(process.execPath, [path.join(REPO, 'server/index.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, SESSION_SECRET: 'sd-test', SECURE_COOKIES: '0', RATE_API_MAX: '100000', STARTING_BALANCE: '1000' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  try {
    await waitForReady(`${BASE}/healthz`);
    const s = newSession();
    await req(s, 'GET', '/api/me');
    await req(s, 'POST', '/api/auth/register', { username: 'statsguy', password: 'longpassword1' });
    for (let i = 0; i < 5; i++) await req(s, 'POST', '/api/play/slots', { bet: 1 });
    for (let i = 0; i < 3; i++) await req(s, 'POST', '/api/play/pinata', { bet: 1, pick: 0 });

    const r = await req(s, 'GET', '/api/stats/detail');
    assert.equal(r.status, 200);
    // per-game
    const bySlots = r.data.perGame.find(g => g.game === 'slots');
    assert.ok(bySlots && bySlots.bets === 5, 'slots grouped with 5 bets');
    assert.equal(typeof bySlots.profit, 'number');
    assert.ok(bySlots.winRate >= 0 && bySlots.winRate <= 1);
    assert.ok(r.data.perGame.some(g => g.game === 'pinata'), 'pinata present');
    // series: dense daily buckets, cumulative is monotone-consistent
    assert.ok(Array.isArray(r.data.series) && r.data.series.length === r.data.days);
    const last = r.data.series[r.data.series.length - 1];
    assert.equal(typeof last.cumulative, 'number');
    // today's bucket carries the 8 bets
    assert.ok(r.data.series.reduce((a, d) => a + d.bets, 0) >= 8, 'series counts all bets');
  } finally {
    child.kill('SIGTERM');
    rmDb();
  }
});
