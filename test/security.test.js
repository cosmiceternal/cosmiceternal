'use strict';

// Security regression suite. Spawns the real server once with a known
// SESSION_SECRET so we can forge/expire tokens exactly the way an attacker
// with a stolen cookie (but not the secret) can't.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const REPO = path.join(__dirname, '..');
const PORT = 6200 + (process.pid % 100);
const BASE = `http://localhost:${PORT}`;
const DB = `/tmp/crypt-test-sec-${process.pid}.db`;
const SECRET = 'test-secret-' + process.pid;

function rmDb() {
  for (const f of [DB, DB + '-shm', DB + '-wal']) { try { fs.unlinkSync(f); } catch (_) {} }
}

function newSession() { return { csrf: '', jar: '' }; }
async function req(sess, method, p, body, extraHeaders = {}) {
  const headers = { Cookie: sess.jar, ...extraHeaders };
  if (body) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && sess.csrf && !('X-CSRF-Token' in extraHeaders)) headers['X-CSRF-Token'] = sess.csrf;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  for (const s of sc) {
    const [pair] = s.split(';');
    const [k, ...v] = pair.split('=');
    const key = k.trim(), val = v.join('=');
    if (key === 'csrf') sess.csrf = val;
    // Replace (not append) cookies by key so re-issued sessions take effect.
    const parts = sess.jar ? sess.jar.split('; ').filter(x => !x.startsWith(key + '=')) : [];
    parts.push(`${key}=${val}`);
    sess.jar = parts.join('; ');
  }
  let data = null; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data, headers: r.headers };
}

// Mint a token the same way the server does (we know the secret in tests).
function forgeToken(userId, epoch, iatSec) {
  const payload = `v2.${userId}.${epoch}.${iatSec}`;
  const mac = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return `${payload}.${mac}`;
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

test('security suite', async (t) => {
  rmDb();
  const child = spawn(process.execPath, [path.join(REPO, 'server/index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT), DB_PATH: DB,
      SESSION_SECRET: SECRET,
      SECURE_COOKIES: '0',
      RATE_API_MAX: '100000',
      RATE_AUTH_MAX: '100000',       // lockout is tested separately from IP rate limiting
      LOCKOUT_THRESHOLD: '5',
      STARTING_BALANCE: '1000'
    },
    stdio: ['ignore', 'ignore', 'inherit']
  });

  try {
    await waitForReady(`${BASE}/healthz`);

    // ---- Bootstrap one account we reuse across subtests ----
    const alice = newSession();
    await req(alice, 'GET', '/api/me');
    let r = await req(alice, 'POST', '/api/auth/register', { username: 'alice', password: 'longpassword1' });
    assert.equal(r.status, 200);
    const aliceId = r.data.user.id;

    await t.test('API responses are no-store', async () => {
      const r = await req(alice, 'GET', '/api/me');
      assert.equal(r.headers.get('cache-control'), 'no-store');
    });

    await t.test('tampered session token is rejected', async () => {
      const evil = newSession();
      // Copy alice's jar but flip the last hex char of the session mac.
      evil.jar = alice.jar.replace(/(cs_session=[^;]+)/, (m) => {
        const flip = m.endsWith('0') ? '1' : '0';
        return m.slice(0, -1) + flip;
      });
      evil.csrf = alice.csrf;
      const r = await req(evil, 'GET', '/api/me');
      assert.equal(r.data.user, null, 'tampered token must not authenticate');
    });

    await t.test('expired token is rejected, fresh one accepted', async () => {
      const THIRTY_ONE_DAYS = 31 * 24 * 60 * 60;
      const stale = newSession();
      stale.jar = `cs_session=${encodeURIComponent(forgeToken(aliceId, 0, Math.floor(Date.now() / 1000) - THIRTY_ONE_DAYS))}`;
      let r = await req(stale, 'GET', '/api/me');
      assert.equal(r.data.user, null, '31-day-old token must be expired');

      const fresh = newSession();
      fresh.jar = `cs_session=${encodeURIComponent(forgeToken(aliceId, 0, Math.floor(Date.now() / 1000)))}`;
      r = await req(fresh, 'GET', '/api/me');
      assert.equal(r.data.user?.id, aliceId, 'fresh forged-with-secret token authenticates (sanity check)');
    });

    await t.test('legacy v1 tokens are rejected', async () => {
      const mac = crypto.createHmac('sha256', SECRET).update(String(aliceId)).digest('hex');
      const legacy = newSession();
      legacy.jar = `cs_session=${encodeURIComponent(`${aliceId}.${mac}`)}`;
      const r = await req(legacy, 'GET', '/api/me');
      assert.equal(r.data.user, null);
    });

    await t.test('password change invalidates other sessions', async () => {
      // Second device signs in as alice.
      const phone = newSession();
      await req(phone, 'GET', '/api/me');
      let r = await req(phone, 'POST', '/api/auth/login', { username: 'alice', password: 'longpassword1' });
      assert.equal(r.status, 200);

      // Original session changes the password.
      r = await req(alice, 'POST', '/api/auth/password', { current: 'longpassword1', next: 'evenlongerpass2' });
      assert.equal(r.status, 200);

      // Phone's old-epoch token is now dead.
      r = await req(phone, 'GET', '/api/me');
      assert.equal(r.data.user, null, 'other session must be invalidated after password change');

      // The changer keeps a live session (route re-issued the cookie).
      r = await req(alice, 'GET', '/api/me');
      assert.equal(r.data.user?.id, aliceId, 'changer keeps their session');
    });

    await t.test('CSRF: state-changing request without header is 403', async () => {
      const r = await req(alice, 'POST', '/api/play/dice',
        { bet: 1, target: 50, dir: 'over' }, { 'X-CSRF-Token': '' });
      assert.equal(r.status, 403);
    });

    await t.test('account lockout after threshold, correct password still blocked', async () => {
      const bob = newSession();
      await req(bob, 'GET', '/api/me');
      let r = await req(bob, 'POST', '/api/auth/register', { username: 'bob', password: 'longpassword1' });
      assert.equal(r.status, 200);
      await req(bob, 'POST', '/api/auth/logout');

      for (let i = 0; i < 5; i++) {
        r = await req(bob, 'POST', '/api/auth/login', { username: 'bob', password: 'wrong-pass-' + i });
        assert.equal(r.status, 401);
      }
      r = await req(bob, 'POST', '/api/auth/login', { username: 'bob', password: 'longpassword1' });
      assert.equal(r.status, 429, 'lockout must hold even for the correct password');
    });

    await t.test('password policy: short / common / contains-username all rejected', async () => {
      const s = newSession();
      await req(s, 'GET', '/api/me');
      let r = await req(s, 'POST', '/api/auth/register', { username: 'carol', password: 'short1' });
      assert.equal(r.status, 400);
      r = await req(s, 'POST', '/api/auth/register', { username: 'carol', password: 'password123' });
      assert.equal(r.status, 400);
      r = await req(s, 'POST', '/api/auth/register', { username: 'carol', password: 'carol12345' });
      assert.equal(r.status, 400);
    });

    await t.test('admin endpoints: non-admin 403, bad id 400', async () => {
      let r = await req(alice, 'GET', '/api/admin/overview');
      assert.equal(r.status, 403);
      // Promote alice directly in the DB, then hit a malformed id.
      const Database = require('better-sqlite3');
      const db = new Database(DB);
      db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(aliceId);
      db.close();
      r = await req(alice, 'GET', '/api/admin/user/not-a-number');
      assert.equal(r.status, 400);
      r = await req(alice, 'POST', `/api/admin/user/${aliceId}/admin`, { isAdmin: false });
      assert.equal(r.status, 400, 'self-demotion must be rejected');
    });
  } finally {
    child.kill('SIGTERM');
    rmDb();
  }
});
