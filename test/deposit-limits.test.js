'use strict';

// Graduated deposit limits + admin controls:
//   - new accounts get the reduced cap; turnover unlocks the full cap;
//   - admins tune the three global knobs and set per-user overrides;
//   - the effective cap is enforced in the deposit path.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const REPO = path.join(__dirname, '..');
const PORT = 6600 + (process.pid % 100);
const BASE = `http://localhost:${PORT}`;
const DB = `/tmp/crypt-test-deplimits-${process.pid}.db`;

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

test('graduated deposit limits + admin controls', async (t) => {
  rmDb();
  const child = spawn(process.execPath, [path.join(REPO, 'server/index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT), DB_PATH: DB,
      SESSION_SECRET: 'dep-test', SECURE_COOKIES: '0',
      RATE_API_MAX: '100000', STARTING_BALANCE: '1000',
      // pin the ramp defaults so the assertions are deterministic
      DEPOSIT_NEW_CAP_CRYPT: '500', DEPOSIT_UNLOCK_CRYPT: '2500', DAILY_DEPOSIT_CAP_CRYPT: '5000'
    },
    stdio: ['ignore', 'ignore', 'inherit']
  });

  try {
    await waitForReady(`${BASE}/healthz`);
    const Database = require('better-sqlite3');
    const promote = (username) => { const db = new Database(DB); db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run(username); db.close(); };
    const addBet = (userId, betCents) => { const db = new Database(DB); db.prepare(`INSERT INTO bets(user_id, game, bet_cents, mult, payout_cents, win, nonce, detail, created_at) VALUES(?, 'slots', ?, 0, 0, 0, 1, NULL, ?)`).run(userId, betCents, Date.now()); db.close(); };

    // Admin session (register, then flip the flag directly — requireAdmin reads it live).
    const admin = newSession();
    await req(admin, 'GET', '/api/me');
    let r = await req(admin, 'POST', '/api/auth/register', { username: 'depadmin', password: 'longpassword1' });
    assert.equal(r.status, 200);
    promote('depadmin');

    await t.test('new account gets the reduced cap; turnover unlocks the full cap', async () => {
      const s = newSession();
      await req(s, 'GET', '/api/me');
      r = await req(s, 'POST', '/api/auth/register', { username: 'newbie', password: 'longpassword1' });
      assert.equal(r.status, 200);
      const uid = r.data.user.id;

      r = await req(s, 'GET', '/api/vault');
      assert.equal(r.data.dailyCapFun, 500, 'new account daily cap is the reduced cap');
      assert.equal(r.data.capTier, 'new');

      // Cross the unlock threshold (2,500 CRYPT wagered) directly.
      addBet(uid, 300000); // 3,000 CRYPT
      r = await req(s, 'GET', '/api/vault');
      assert.equal(r.data.dailyCapFun, 5000, 'full cap unlocks after turnover');
      assert.equal(r.data.capTier, 'full');
    });

    await t.test('admin tunes global config; a new account reflects it', async () => {
      r = await req(admin, 'POST', '/api/admin/settings', { deposit: { newCap: 100, unlock: 1000, fullCap: 2000 } });
      assert.equal(r.status, 200);
      assert.equal(r.data.deposit.newCap, 100);

      const s = newSession();
      await req(s, 'GET', '/api/me');
      r = await req(s, 'POST', '/api/auth/register', { username: 'newbie2', password: 'longpassword1' });
      const uid = r.data.user.id;
      r = await req(s, 'GET', '/api/vault');
      assert.equal(r.data.dailyCapFun, 100, 'reflects the admin-set new-account cap');

      // Per-user override beats the ramp.
      r = await req(admin, 'POST', `/api/admin/user/${uid}/deposit-limit`, { limit: 750 });
      assert.equal(r.status, 200);
      assert.equal(r.data.tier, 'override');
      r = await req(s, 'GET', '/api/vault');
      assert.equal(r.data.dailyCapFun, 750, 'override wins over the ramp');
      assert.equal(r.data.capTier, 'override');

      // Clearing the override falls back to the (admin-set) new cap.
      r = await req(admin, 'POST', `/api/admin/user/${uid}/deposit-limit`, { limit: null });
      assert.equal(r.status, 200);
      r = await req(s, 'GET', '/api/vault');
      assert.equal(r.data.dailyCapFun, 100);
      assert.equal(r.data.capTier, 'new');

      // Enforcement: a deposit over the effective cap is refused; within it is accepted.
      r = await req(s, 'POST', '/api/vault/deposit', { currency: 'USDT', amount: 150 }); // 150 CRYPT > 100 cap
      assert.equal(r.status, 429, 'deposit over the cap is refused');
      r = await req(s, 'POST', '/api/vault/deposit', { currency: 'USDT', amount: 50 });  // within cap
      assert.equal(r.status, 200, 'deposit within the cap is accepted');
    });

    await t.test('non-admin cannot reach admin controls', async () => {
      const s = newSession();
      await req(s, 'GET', '/api/me');
      await req(s, 'POST', '/api/auth/register', { username: 'peon', password: 'longpassword1' });
      r = await req(s, 'POST', '/api/admin/settings', { deposit: { newCap: 1 } });
      assert.equal(r.status, 403, 'requireAdmin blocks non-admins');
    });
  } finally {
    child.kill('SIGTERM');
    rmDb();
  }
});
