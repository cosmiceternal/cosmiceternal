'use strict';

// The per-username lockout must cap guesses even when attempts arrive in
// parallel.
//
// It used to be a check-then-act: login() read the failure count, then spent
// ~50-100ms in argon2 before recording its own failure. Node dispatched every
// parallel request through that read before the first write landed, so N
// simultaneous guesses all saw fails=0 and every one got a free password check
// — the 5-attempt cap simply never engaged, and an attacker could brute force
// at the rate limiter's ceiling instead. Attempts are now chained per username.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { waitForReady } = require('./helpers/server-ready');

const REPO = path.join(__dirname, '..');
const PORT = 6500 + (process.pid % 100);
const BASE = `http://localhost:${PORT}`;
const DB = `/tmp/crypt-test-lockout-${process.pid}.db`;
const THRESHOLD = 5;

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

test('parallel login attempts cannot outrun the lockout', async (t) => {
  rmDb();
  const child = spawn(process.execPath, [path.join(REPO, 'server/index.js')], {
    env: {
      ...process.env, PORT: String(PORT), DB_PATH: DB, SESSION_SECRET: 'lockout-test',
      SECURE_COOKIES: '0', RATE_API_MAX: '100000', RATE_AUTH_MAX: '100000',
      LOCKOUT_THRESHOLD: String(THRESHOLD)
    },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  try {
    await waitForReady(`${BASE}/healthz`, { child });
    const s = newSession();
    await req(s, 'GET', '/api/me');
    await req(s, 'POST', '/api/auth/register', { username: 'victim', password: 'correcthorse9' });

    // 20 simultaneous wrong-password guesses from 20 separate connections.
    // Prime each session first so it holds a CSRF token — otherwise the POSTs
    // are rejected at the CSRF gate and never reach the lockout at all.
    const ATTEMPTS = 20;
    const attackers = Array.from({ length: ATTEMPTS }, () => newSession());
    await Promise.all(attackers.map(a => req(a, 'GET', '/api/me')));

    // Only the first THRESHOLD may be checked; everything after must be locked
    // out (429), not handed a free guess.
    const results = await Promise.all(
      attackers.map((a, i) => req(a, 'POST', '/api/auth/login', { username: 'victim', password: `guess-${i}` }))
    );
    const checked = results.filter(r => r.status === 401).length;  // password actually tried
    const lockedOut = results.filter(r => r.status === 429).length;

    assert.ok(checked <= THRESHOLD, `at most ${THRESHOLD} guesses may be checked, got ${checked}`);
    assert.equal(checked + lockedOut, ATTEMPTS, 'every attempt is either checked or locked out');
    assert.ok(lockedOut > 0, 'the lockout engaged');

    await t.test('the correct password is refused once locked out', async () => {
      const fresh = newSession();
      await req(fresh, 'GET', '/api/me'); // prime CSRF
      const r = await req(fresh, 'POST', '/api/auth/login', { username: 'victim', password: 'correcthorse9' });
      assert.equal(r.status, 429, 'lockout holds even for the right password');
    });
  } finally {
    child.kill('SIGTERM');
    rmDb();
  }
});
