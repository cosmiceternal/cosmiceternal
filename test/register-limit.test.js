'use strict';

// Registration has a dedicated, tighter per-IP rate limit than sign-in, to bound
// bulk account-enumeration and automated signup. A real visitor registers once
// and never notices; past the budget, further registrations from the same IP get
// a 429 while sign-in (on its own, looser limiter) keeps working.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { waitForReady } = require('./helpers/server-ready');

const REPO = path.join(__dirname, '..');
const PORT = 7600 + (process.pid % 100);   // unique base — see test/ports.test.js
const BASE = `http://localhost:${PORT}`;
const DB = `/tmp/crypt-test-reglimit-${process.pid}.db`;
const CAP = 3;                              // tiny cap so the test is fast + deterministic

function rmDb() { for (const f of [DB, DB + '-shm', DB + '-wal']) { try { fs.unlinkSync(f); } catch (_) {} } }
function newSession() { return { csrf: '', jar: '' }; }
async function req(sess, method, p, body) {
  const headers = { Cookie: sess.jar };
  if (body) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && sess.csrf) headers['X-CSRF-Token'] = sess.csrf;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  for (const s of sc) {
    const [pair] = s.split(';'); const [k, ...v] = pair.split('=');
    const key = k.trim(), val = v.join('=');
    if (key === 'csrf') sess.csrf = val;
    const parts = sess.jar ? sess.jar.split('; ').filter(x => !x.startsWith(key + '=')) : [];
    parts.push(`${key}=${val}`); sess.jar = parts.join('; ');
  }
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}

test('registration is rate-limited per IP, independently of sign-in', async (t) => {
  rmDb();
  const child = spawn(process.execPath, [path.join(REPO, 'server/index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT), DB_PATH: DB, SESSION_SECRET: 'reglimit-test', SECURE_COOKIES: '0',
      RATE_API_MAX: '100000', RATE_AUTH_MAX: '100000',   // keep the other limiters out of the way
      RATE_REGISTER_MAX: String(CAP), RATE_REGISTER_WINDOW_MS: '3600000',
      STARTING_BALANCE: '1000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await waitForReady(`${BASE}/healthz`, { child });
    const s = newSession();
    await req(s, 'GET', '/api/me');

    await t.test('registrations up to the cap succeed, then 429', async () => {
      for (let i = 0; i < CAP; i++) {
        const r = await req(s, 'POST', '/api/auth/register', { username: `usr${i}`, password: 'longpassword1' });
        assert.equal(r.status, 200, `registration ${i} should succeed: ${JSON.stringify(r.data)}`);
      }
      const over = await req(s, 'POST', '/api/auth/register', { username: 'onemoreacct', password: 'longpassword1' });
      assert.equal(over.status, 429, 'registration past the cap is rejected');
    });

    await t.test('sign-in still works after registration is capped', async () => {
      // An already-registered account can still sign in — the register cap does
      // not lock a real user out of their account.
      const s2 = newSession();
      await req(s2, 'GET', '/api/me');
      const login = await req(s2, 'POST', '/api/auth/login', { username: 'usr0', password: 'longpassword1' });
      assert.equal(login.status, 200, 'sign-in unaffected by the registration cap: ' + JSON.stringify(login.data));
    });
  } finally {
    child.kill('SIGTERM');
    rmDb();
  }
});
