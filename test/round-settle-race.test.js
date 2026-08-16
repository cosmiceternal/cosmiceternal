'use strict';

// A staked round must pay out exactly once, no matter how many cashouts race.
//
// Before the fix, every settle path gated on a plain `SELECT rounds.settled`
// and then ran an unconditional `UPDATE rounds SET settled = 1`. On Postgres
// (READ COMMITTED) that SELECT takes no row lock, so two concurrent cashouts
// for one roundId both saw settled=0 and both credited the payout. settleRound
// now flips 0 -> 1 conditionally and throws 409 when it loses the race, which
// rolls back the loser's payout with it.
//
// SQLite serializes transactions, so this suite can't reproduce the Postgres
// interleaving directly — it locks the observable contract (one payout, one
// success, the rest rejected) and asserts the guard is genuinely conditional.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { waitForReady } = require('./helpers/server-ready');

const REPO = path.join(__dirname, '..');
const PORT = 7100 + (process.pid % 100);   // unique base — see test/ports.test.js
const BASE = `http://localhost:${PORT}`;
const DB = `/tmp/crypt-test-settle-${process.pid}.db`;

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
const balance = async (s) => (await req(s, 'GET', '/api/me')).data.user.balance;

test('a round pays out exactly once under racing cashouts', async (t) => {
  rmDb();
  const child = spawn(process.execPath, [path.join(REPO, 'server/index.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, SESSION_SECRET: 'settle-test', SECURE_COOKIES: '0', RATE_API_MAX: '100000', STARTING_BALANCE: '1000' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  try {
    await waitForReady(`${BASE}/healthz`, { child });

    // Open a mines round and reveal exactly one safe tile, so the round is
    // still LIVE and a cashout is worth more than the stake. Returns null if
    // the round ended (bust, or board cleared) — the caller just retries.
    // minesReveal reports a mine as `hit: true` and a full clear as `cleared`;
    // both settle the round server-side.
    async function openRound(s, bet = 10) {
      const start = await req(s, 'POST', '/api/play/mines/start', { bet, mines: 3 });
      assert.equal(start.status, 200, 'mines round started');
      const roundId = start.data.roundId;
      const r = await req(s, 'POST', '/api/play/mines/reveal', { roundId, cell: 0 });
      if (r.status !== 200) return null;
      if (r.data.hit || r.data.cleared) return null; // round is over — retry
      return roundId;                                 // live round, one safe tile
    }

    await t.test('concurrent cashouts: exactly one succeeds, credited once', async () => {
      const s = newSession();
      await req(s, 'GET', '/api/me');
      await req(s, 'POST', '/api/auth/register', { username: 'racer1', password: 'longpassword1' });

      let roundId = null;
      for (let i = 0; i < 20 && !roundId; i++) roundId = await openRound(s);
      assert.ok(roundId, 'opened a live mines round with a safe reveal');

      const before = await balance(s);
      // Fire several cashouts for the same round at once.
      const results = await Promise.all(Array.from({ length: 6 }, () => req(s, 'POST', '/api/play/mines/cashout', { roundId })));
      const ok = results.filter(r => r.status === 200);
      const rejected = results.filter(r => r.status === 409);

      assert.equal(ok.length, 1, 'exactly one cashout settles the round');
      assert.equal(ok.length + rejected.length, 6, 'the rest are rejected 409, not 500s');

      const after = await balance(s);
      const credited = +(after - before).toFixed(2);
      assert.equal(credited, ok[0].data.payout, 'balance moved by exactly one payout');
    });

    await t.test('the settle guard is conditional, not a blind write', async () => {
      const s = newSession();
      await req(s, 'GET', '/api/me');
      await req(s, 'POST', '/api/auth/register', { username: 'racer2', password: 'longpassword1' });

      let roundId = null;
      for (let i = 0; i < 20 && !roundId; i++) roundId = await openRound(s);
      assert.ok(roundId);

      const first = await req(s, 'POST', '/api/play/mines/cashout', { roundId });
      assert.equal(first.status, 200);
      const afterFirst = await balance(s);

      // A settled round can never pay again, however many times it's replayed.
      for (let i = 0; i < 3; i++) {
        const again = await req(s, 'POST', '/api/play/mines/cashout', { roundId });
        assert.equal(again.status, 409, 'replayed cashout is rejected');
      }
      assert.equal(await balance(s), afterFirst, 'balance unchanged by replays');
    });
  } finally {
    child.kill('SIGTERM');
    rmDb();
  }
});
