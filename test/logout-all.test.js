'use strict';

// "Sign out everywhere" (POST /api/auth/logout { all: true }) must revoke every
// OTHER session for the account — including a token that was captured — while
// keeping the device that pulled the lever signed in. It works by bumping the
// account's session epoch; authenticate() rejects any token minted at an older
// epoch on its next request. This is the user's own handle on a compromised
// session, mirroring the admin force-logout and the password-change revoke.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { waitForReady } = require('./helpers/server-ready');

const REPO = path.join(__dirname, '..');
const PORT = 7500 + (process.pid % 100);   // unique base — see test/ports.test.js
const BASE = `http://localhost:${PORT}`;
const DB = `/tmp/crypt-test-logoutall-${process.pid}.db`;

function rmDb() { for (const f of [DB, DB + '-shm', DB + '-wal']) { try { fs.unlinkSync(f); } catch (_) {} } }
function newSession() { return { csrf: '', jar: '' }; }
async function req(sess, method, p, body) {
  const headers = { Cookie: sess.jar };
  if (body) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && sess.csrf) headers['X-CSRF-Token'] = sess.csrf;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  for (const s of sc) {
    const [pair] = s.split(';');
    const [k, ...v] = pair.split('=');
    const key = k.trim(), val = v.join('=');
    if (key === 'csrf') sess.csrf = val;
    const parts = sess.jar ? sess.jar.split('; ').filter(x => !x.startsWith(key + '=')) : [];
    parts.push(`${key}=${val}`);
    sess.jar = parts.join('; ');
  }
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}
// Log in as an existing user from a FRESH browser (new cookie jar) — this is the
// "second device". Each call mints its own session token.
async function signInNewDevice(username, password) {
  const s = newSession();
  await req(s, 'GET', '/api/me');                 // seed the csrf cookie
  const r = await req(s, 'POST', '/api/auth/login', { username, password });
  assert.equal(r.status, 200, 'login should succeed: ' + JSON.stringify(r.data));
  return s;
}

test('sign-out-everywhere kills other devices but keeps the current one', async (t) => {
  rmDb();
  const child = spawn(process.execPath, [path.join(REPO, 'server/index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT), DB_PATH: DB,
      SESSION_SECRET: 'logoutall-test', SECURE_COOKIES: '0',
      RATE_API_MAX: '100000', RATE_AUTH_MAX: '100000', STARTING_BALANCE: '1000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await waitForReady(`${BASE}/healthz`, { child });

    // Register on device A, then sign in the same account on devices B and C.
    const a = newSession();
    await req(a, 'GET', '/api/me');
    const reg = await req(a, 'POST', '/api/auth/register', { username: 'owner', password: 'longpassword1' });
    assert.equal(reg.status, 200, 'register: ' + JSON.stringify(reg.data));
    const b = await signInNewDevice('owner', 'longpassword1');
    const c = await signInNewDevice('owner', 'longpassword1');

    // All three sessions are live.
    for (const [name, s] of [['A', a], ['B', b], ['C', c]]) {
      const me = await req(s, 'GET', '/api/me');
      assert.ok(me.data.user, `device ${name} should be signed in before revoke`);
    }

    await t.test('revoking from A keeps A in and logs B and C out', async () => {
      const out = await req(a, 'POST', '/api/auth/logout', { all: true });
      assert.equal(out.status, 200, 'logout-all: ' + JSON.stringify(out.data));
      assert.equal(out.data.scope, 'all', 'reports the all-scope revoke');

      // A re-minted its cookie at the new epoch — still signed in.
      const meA = await req(a, 'GET', '/api/me');
      assert.ok(meA.data.user, 'device A stays signed in');

      // B and C were minted at the old epoch — their next request is anonymous.
      const meB = await req(b, 'GET', '/api/me');
      assert.equal(meB.data.user, null, 'device B is revoked');
      const meC = await req(c, 'GET', '/api/me');
      assert.equal(meC.data.user, null, 'device C is revoked');
    });

    await t.test('a revoked device cannot act, even on a state-changing call', async () => {
      // B still holds a csrf cookie, so CSRF passes; auth must still reject it.
      const bet = await req(b, 'POST', '/api/play/dice', { bet: 1, target: 50, dir: 'over' });
      assert.equal(bet.status, 401, 'revoked session cannot place a bet: ' + JSON.stringify(bet.data));
    });

    await t.test('a plain logout still just drops the current cookie', async () => {
      const d = await signInNewDevice('owner', 'longpassword1');
      const e = await signInNewDevice('owner', 'longpassword1');
      const out = await req(d, 'POST', '/api/auth/logout', {});
      assert.equal(out.status, 200);
      assert.ok(!out.data.scope, 'plain logout is not an all-scope revoke');
      // The OTHER device (e) is untouched by a plain logout.
      const meE = await req(e, 'GET', '/api/me');
      assert.ok(meE.data.user, 'a plain logout does not revoke other devices');
    });
  } finally {
    child.kill('SIGTERM');
    rmDb();
  }
});
