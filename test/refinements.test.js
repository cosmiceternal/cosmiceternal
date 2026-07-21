'use strict';

// Regression guards for the code-refinement audit's security fixes:
//   1. sub-cent stakes that round to 0 are rejected (no free XP farming);
//   2. changing the client seed does NOT reset the nonce (closes deterministic
//      outcome replay while the server seed is secret);
//   3. the daily bonus credits at most once under concurrent claims.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const REPO = path.join(__dirname, '..');
const PORT = 6900 + (process.pid % 100);
const BASE = `http://localhost:${PORT}`;
const DB = `/tmp/crypt-test-refine-${process.pid}.db`;

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

test('refinement security fixes', async (t) => {
  rmDb();
  const child = spawn(process.execPath, [path.join(REPO, 'server/index.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, SESSION_SECRET: 'refine-test', SECURE_COOKIES: '0', RATE_API_MAX: '100000', STARTING_BALANCE: '1000' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  try {
    await waitForReady(`${BASE}/healthz`);

    await t.test('sub-cent bets that round to 0 are rejected', async () => {
      const s = newSession();
      await req(s, 'GET', '/api/me');
      await req(s, 'POST', '/api/auth/register', { username: 'penny', password: 'longpassword1' });
      let r = await req(s, 'POST', '/api/play/slots', { bet: 0.004 }); // rounds to 0 cents
      assert.equal(r.status, 400, 'zero-rounding stake rejected');
      r = await req(s, 'POST', '/api/play/slots', { bet: 0 });
      assert.equal(r.status, 400);
      r = await req(s, 'POST', '/api/play/slots', { bet: 0.01 }); // valid 1-cent minimum
      assert.equal(r.status, 200);
    });

    await t.test('changing the client seed keeps the nonce monotonic (no replay)', async () => {
      const s = newSession();
      await req(s, 'GET', '/api/me');
      await req(s, 'POST', '/api/auth/register', { username: 'seedy', password: 'longpassword1' });
      let r = await req(s, 'GET', '/api/fair');
      assert.equal(r.data.nonce, 0);
      await req(s, 'POST', '/api/play/slots', { bet: 1 }); // advances nonce -> 1
      await req(s, 'POST', '/api/play/slots', { bet: 1 }); // -> 2
      r = await req(s, 'GET', '/api/fair');
      assert.equal(r.data.nonce, 2, 'two bets advanced the nonce');
      r = await req(s, 'POST', '/api/fair/client', { clientSeed: 'replay-me' });
      assert.equal(r.status, 200);
      assert.equal(r.data.clientSeed, 'replay-me');
      assert.equal(r.data.nonce, 2, 'nonce must NOT reset on a client-seed change');
    });

    await t.test('daily bonus credits at most once under concurrent claims', async () => {
      const s = newSession();
      await req(s, 'GET', '/api/me');
      await req(s, 'POST', '/api/auth/register', { username: 'claimer', password: 'longpassword1' });
      // Fire several concurrent claims; exactly one must succeed.
      const results = await Promise.all(Array.from({ length: 6 }, () => req(s, 'POST', '/api/progression/claim-daily')));
      const ok = results.filter(r => r.status === 200).length;
      const rejected = results.filter(r => r.status === 409).length;
      assert.equal(ok, 1, 'exactly one claim credited');
      assert.equal(ok + rejected, 6, 'the rest are 409, not 500s');
    });
  } finally {
    child.kill('SIGTERM');
    rmDb();
  }
});
