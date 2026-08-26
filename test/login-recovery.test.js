'use strict';

// The sign-in contract from a real player's point of view.
//
// The lockout exists to stop online guessing, but it used to punish the far
// more common case: someone mistyping their OWN password. At a threshold of 5,
// a player who fumbled five times was refused for a full 15 minutes — even with
// the correct password — with no way to recover. For a play-money casino people
// share with friends, that is a "guess I can't get in" moment, and the security
// it bought was marginal: argon2id (~100ms a try) plus the per-IP auth rate
// limit already make online brute force hopeless.
//
// So: a fumbling player still gets in, a genuine brute-force run still gets
// locked out, and the lockout message states the real remaining wait rather
// than always quoting the full window.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { waitForReady } = require('./helpers/server-ready');

const REPO = path.join(__dirname, '..');
const PORT = 7300 + (process.pid % 100);   // unique base — see test/ports.test.js
const BASE = `http://localhost:${PORT}`;
const DB = `/tmp/crypt-test-login-recovery-${process.pid}.db`;
const PASS = 'Trombone7Willow2Cliff';
const WINDOW_MS = 4000;                    // short window so recovery is testable

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
// Each login gets a fresh session, the way separate browser attempts would.
async function login(username, password) {
  const s = newSession();
  await req(s, 'GET', '/api/me');
  return req(s, 'POST', '/api/auth/login', { username, password });
}

test('sign-in survives a fumbling player but still stops brute force', async (t) => {
  rmDb();
  const child = spawn(process.execPath, [path.join(REPO, 'server/index.js')], {
    env: {
      ...process.env, PORT: String(PORT), DB_PATH: DB, SESSION_SECRET: 'login-recovery',
      SECURE_COOKIES: '0', RATE_API_MAX: '100000',
      RATE_AUTH_MAX: '100000',            // isolate the lockout from IP rate limiting
      LOCKOUT_THRESHOLD: '10',
      LOCKOUT_WINDOW_MS: String(WINDOW_MS)
    },
    stdio: ['ignore', 'ignore', 'inherit']
  });

  try {
    await waitForReady(`${BASE}/healthz`, { child });

    await t.test('a player who mistypes several times can still get in', async () => {
      const s = newSession();
      await req(s, 'GET', '/api/me');
      const reg = await req(s, 'POST', '/api/auth/register', { username: 'fumbler', password: PASS });
      assert.equal(reg.status, 200, 'registered');

      // Seven wrong guesses — a plausible run of typos, under the threshold.
      for (let i = 0; i < 7; i++) {
        const bad = await login('fumbler', 'wrongpass' + i);
        assert.equal(bad.status, 401, `guess ${i + 1} is rejected, not locked out`);
      }

      const good = await login('fumbler', PASS);
      assert.equal(good.status, 200, 'the correct password still signs the player in');
    });

    await t.test('a sustained guessing run is locked out', async () => {
      const s = newSession();
      await req(s, 'GET', '/api/me');
      await req(s, 'POST', '/api/auth/register', { username: 'target', password: PASS });

      let locked = 0;
      for (let i = 0; i < 14; i++) {
        const r = await login('target', 'guess' + i);
        if (r.status === 429) { locked = i + 1; break; }
      }
      assert.ok(locked > 0, 'the lockout engages on a sustained run');
      assert.ok(locked > 10, `lockout engaged only after the threshold (attempt ${locked})`);

      // While locked, even the right password is refused — that is the point.
      const held = await login('target', PASS);
      assert.equal(held.status, 429, 'lockout holds even for the correct password');
      assert.match(held.data.error, /try again/i, 'the message tells the player to try again later');
    });

    await t.test('the lockout message quotes a real wait, and it does lift', async () => {
      const s = newSession();
      await req(s, 'GET', '/api/me');
      await req(s, 'POST', '/api/auth/register', { username: 'waiter', password: PASS });
      for (let i = 0; i < 12; i++) await login('waiter', 'nope' + i);

      const locked = await login('waiter', PASS);
      assert.equal(locked.status, 429, 'locked out');
      // The window here is 4s, so the wait must NOT claim the old fixed 15 minutes.
      assert.doesNotMatch(locked.data.error, /15 minutes/,
        'the wait is computed from the sliding window, not the full window constant');

      // Once the failures age out of the window, the player is let back in.
      await new Promise((r) => { setTimeout(r, WINDOW_MS + 1200); });
      const back = await login('waiter', PASS);
      assert.equal(back.status, 200, 'the lockout lifts on its own and the player can sign in');
    });
  } finally {
    child.kill('SIGTERM');
    rmDb();
  }
});
