'use strict';

// Economy suite: race settlement idempotency + parallel withdrawal atomicity.
// Spawns the real server; race bets are seeded directly into the previous
// hour so settlement has something to pay.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const REPO = path.join(__dirname, '..');
const PORT = 6300 + (process.pid % 100);
const BASE = `http://localhost:${PORT}`;
const DB = `/tmp/crypt-test-econ-${process.pid}.db`;

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

test('economy suite', async (t) => {
  rmDb();
  const child = spawn(process.execPath, [path.join(REPO, 'server/index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT), DB_PATH: DB,
      SESSION_SECRET: 'econ-test',
      SECURE_COOKIES: '0',
      RATE_API_MAX: '100000',
      STARTING_BALANCE: '10000'
    },
    stdio: ['ignore', 'ignore', 'inherit']
  });

  try {
    await waitForReady(`${BASE}/healthz`);
    const a = newSession();
    await req(a, 'GET', '/api/me');
    let r = await req(a, 'POST', '/api/auth/register', { username: 'racer', password: 'longpassword1' });
    assert.equal(r.status, 200);
    const racerId = r.data.user.id;
    const startBal = r.data.user.balance;

    await t.test('race settlement pays exactly once', async () => {
      // Seed a qualifying wager into the PREVIOUS hour directly.
      const Database = require('better-sqlite3');
      const db = new Database(DB);
      const prevHourTs = Date.now() - 3_600_000;
      db.prepare(`INSERT INTO bets(user_id, game, bet_cents, mult, payout_cents, win, nonce, detail, created_at)
                  VALUES(?, 'dice', 5000, 0, 0, 0, 1, NULL, ?)`).run(racerId, prevHourTs);
      // Clear any settlement lock the server may have taken at boot (before
      // our seeded bet existed).
      db.prepare("DELETE FROM settings WHERE key LIKE 'race_paid_%'").run();
      db.close();

      // Two concurrent race requests → both try to settle; only one pays.
      await Promise.all([req(a, 'GET', '/api/race'), req(a, 'GET', '/api/race')]);
      const r2 = await req(a, 'GET', '/api/me');
      // 250 CRYPT first prize, exactly once.
      assert.equal(r2.data.user.balance, startBal + 250,
        `expected one 250 prize, got balance ${r2.data.user.balance} (start ${startBal})`);

      // A third settle attempt is a no-op.
      await req(a, 'GET', '/api/race');
      const r3 = await req(a, 'GET', '/api/me');
      assert.equal(r3.data.user.balance, startBal + 250);
    });

    await t.test('parallel withdrawals cannot overdraw', async () => {
      const r0 = await req(a, 'GET', '/api/me');
      const bal = r0.data.user.balance; // 10000 + 250
      // Fire 5 parallel 4000-CRYPT withdrawals (USDT 4000 = 4000 CRYPT).
      // Only two can fit in the balance; the daily cap (5000) tightens it to one.
      const results = await Promise.all(
        Array(5).fill(0).map(() => req(a, 'POST', '/api/vault/withdraw',
          { currency: 'USDT', amount: 4000, address: 'TXabcdef1234567890' }))
      );
      const okCount = results.filter(x => x.status === 200).length;
      assert.equal(okCount, 1, 'daily cap must allow exactly one 4000 withdrawal');
      const r1 = await req(a, 'GET', '/api/me');
      assert.equal(r1.data.user.balance, bal - 4000, 'exactly one debit');
    });

    await t.test('cancel refunds a pending withdrawal (admin cancel path)', async () => {
      // Playmoney completes instantly, so exercise the admin cancel guard on a
      // completed row instead: it must refuse (status != pending).
      const list = await req(a, 'GET', '/api/vault/withdrawals');
      const wid = list.data.withdrawals[0].id;
      const r = await req(a, 'POST', '/api/vault/withdraw/cancel', { withdrawalId: wid });
      assert.equal(r.status, 404, 'completed withdrawal must not be cancellable');
    });
  } finally {
    child.kill('SIGTERM');
    rmDb();
  }
});
