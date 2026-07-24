'use strict';

// The wins/biggest leaderboards cache their shared full-table aggregate for a
// few seconds. Guard that the cache holds only the viewer-independent part:
// each viewer's own value/rank must stay correct and must not bleed from
// whoever populated the cache.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const REPO = path.join(__dirname, '..');
const PORT = 6700 + (process.pid % 100);
const BASE = `http://localhost:${PORT}`;
const DB = `/tmp/crypt-test-lbcache-${process.pid}.db`;

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
async function mkUser(name) {
  const s = newSession();
  await req(s, 'GET', '/api/me');
  await req(s, 'POST', '/api/auth/register', { username: name, password: 'longpassword1' });
  return s;
}
// Limbo at target 1.01 wins ~99% of the time — a near-deterministic way to
// accumulate wins.
async function winSome(s, n) { for (let i = 0; i < n; i++) await req(s, 'POST', '/api/play/limbo', { bet: 1, target: 1.01 }); }

test('leaderboard cache: per-viewer rank/value stays correct across viewers', async () => {
  rmDb();
  const child = spawn(process.execPath, [path.join(REPO, 'server/index.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, SESSION_SECRET: 'lb-test', SECURE_COOKIES: '0', RATE_API_MAX: '100000', STARTING_BALANCE: '1000' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  try {
    await waitForReady(`${BASE}/healthz`);
    const A = await mkUser('alpha');
    const B = await mkUser('bravo');
    await winSome(A, 14);
    await winSome(B, 3);

    const statsA = (await req(A, 'GET', '/api/stats')).data;
    const statsB = (await req(B, 'GET', '/api/stats')).data;
    assert.ok(statsA.wins > statsB.wins, 'alpha won more than bravo');

    // A queries first (populates the shared cache), then B queries within the
    // cache window. Each must see THEIR OWN wins, not the cached viewer's.
    const lbA = (await req(A, 'GET', '/api/leaderboard?metric=wins')).data;
    const lbB = (await req(B, 'GET', '/api/leaderboard?metric=wins')).data;

    assert.equal(lbA.you.value, statsA.wins, 'A sees its own win count');
    assert.equal(lbB.you.value, statsB.wins, 'B sees its own win count (no cache bleed)');
    assert.ok(lbA.you.rank <= lbB.you.rank, 'more wins ranks no worse');

    // top list is sorted descending by value and is shared/consistent.
    const vals = lbA.top.map(r => r.value);
    for (let i = 1; i < vals.length; i++) assert.ok(vals[i] <= vals[i - 1], 'top sorted desc');
    assert.deepEqual(lbB.top.map(r => r.value), vals, 'shared top identical for both viewers');

    // A second A query (cache hit) is still correct.
    const lbA2 = (await req(A, 'GET', '/api/leaderboard?metric=wins')).data;
    assert.equal(lbA2.you.value, statsA.wins);
  } finally {
    child.kill('SIGTERM');
    rmDb();
  }
});
