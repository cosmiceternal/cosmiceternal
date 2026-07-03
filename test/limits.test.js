'use strict';

// Responsible-gaming enforcement: loss limit stops wagers at the cap;
// self-exclusion blocks wagers and deposits but NOT withdrawals; exclusion
// cannot be shortened.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const REPO = path.join(__dirname, '..');
const PORT = 6400 + (process.pid % 100);
const BASE = `http://localhost:${PORT}`;
const DB = `/tmp/crypt-test-limits-${process.pid}.db`;

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

test('responsible gaming suite', async (t) => {
  rmDb();
  const child = spawn(process.execPath, [path.join(REPO, 'server/index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT), DB_PATH: DB,
      SESSION_SECRET: 'limits-test', SECURE_COOKIES: '0',
      RATE_API_MAX: '100000', STARTING_BALANCE: '1000'
    },
    stdio: ['ignore', 'ignore', 'inherit']
  });

  try {
    await waitForReady(`${BASE}/healthz`);

    await t.test('loss limit blocks wagers once net loss reaches the cap', async () => {
      const s = newSession();
      await req(s, 'GET', '/api/me');
      let r = await req(s, 'POST', '/api/auth/register', { username: 'capped', password: 'longpassword1' });
      assert.equal(r.status, 200);
      const userId = r.data.user.id;
      r = await req(s, 'POST', '/api/limits/loss-limit', { lossLimit: 50 });
      assert.equal(r.status, 200);
      assert.equal(r.data.lossLimit, 50);

      // Force a 60-CRYPT recorded loss directly (deterministic, no RNG grind).
      const Database = require('better-sqlite3');
      const db = new Database(DB);
      db.prepare(`INSERT INTO bets(user_id, game, bet_cents, mult, payout_cents, win, nonce, detail, created_at)
                  VALUES(?, 'dice', 6000, 0, 0, 0, 1, NULL, ?)`).run(userId, Date.now());
      db.close();

      r = await req(s, 'POST', '/api/play/dice', { bet: 1, target: 50, dir: 'over' });
      assert.equal(r.status, 403, 'wager must be blocked at the loss limit');
      assert.match(r.data.error, /loss limit/i);

      // Removing the limit unblocks.
      r = await req(s, 'POST', '/api/limits/loss-limit', { lossLimit: null });
      assert.equal(r.status, 200);
      r = await req(s, 'POST', '/api/play/dice', { bet: 1, target: 50, dir: 'over' });
      assert.equal(r.status, 200);
    });

    await t.test('self-exclusion blocks wagers + deposits, allows withdrawals, never shortens', async () => {
      const s = newSession();
      await req(s, 'GET', '/api/me');
      let r = await req(s, 'POST', '/api/auth/register', { username: 'excluded', password: 'longpassword1' });
      assert.equal(r.status, 200);

      r = await req(s, 'POST', '/api/limits/self-exclude', { days: 7 });
      assert.equal(r.status, 200);
      const until7 = r.data.excludedUntil;
      assert.ok(until7 > Date.now());

      r = await req(s, 'POST', '/api/play/dice', { bet: 1, target: 50, dir: 'over' });
      assert.equal(r.status, 403, 'wagering must be blocked');
      r = await req(s, 'POST', '/api/vault/deposit', { currency: 'USDT', amount: 10 });
      assert.equal(r.status, 403, 'deposits must be blocked');
      r = await req(s, 'POST', '/api/vault/withdraw', { currency: 'USDT', amount: 100, address: 'TXabcdef1234567890' });
      assert.equal(r.status, 200, 'withdrawals must remain available');

      // A 1-day exclusion request must not shorten the active 7-day one.
      r = await req(s, 'POST', '/api/limits/self-exclude', { days: 1 });
      assert.equal(r.status, 200);
      assert.equal(r.data.excludedUntil, until7, 'exclusion must never shorten');

      // Invalid period rejected.
      r = await req(s, 'POST', '/api/limits/self-exclude', { days: 3 });
      assert.equal(r.status, 400);
    });
  } finally {
    child.kill('SIGTERM');
    rmDb();
  }
});
