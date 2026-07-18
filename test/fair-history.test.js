'use strict';

// Per-bet provably-fair persistence: every settled bet records the nonce, the
// committed server-seed hash, and the client seed it used, and the history API
// exposes them — so any past bet can be re-derived once its seed is revealed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const fair = require('../server/fair.js');

const REPO = path.join(__dirname, '..');
const PORT = 6700 + (process.pid % 100);
const BASE = `http://localhost:${PORT}`;
const DB = `/tmp/crypt-test-fairhist-${process.pid}.db`;

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

test('past bets persist + expose their fairness coordinates and re-derive', async (t) => {
  rmDb();
  const child = spawn(process.execPath, [path.join(REPO, 'server/index.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, SESSION_SECRET: 'fh-test', SECURE_COOKIES: '0', RATE_API_MAX: '100000', STARTING_BALANCE: '1000' },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  try {
    await waitForReady(`${BASE}/healthz`);
    const s = newSession();
    await req(s, 'GET', '/api/me');
    let r = await req(s, 'POST', '/api/auth/register', { username: 'verifier', password: 'longpassword1' });
    assert.equal(r.status, 200);

    // Play a few slots bets under the current (committed) seed.
    for (let i = 0; i < 4; i++) { r = await req(s, 'POST', '/api/play/slots', { bet: 1 }); assert.equal(r.status, 200); }

    await t.test('history exposes nonce, serverHash, clientSeed per bet', async () => {
      const h = await req(s, 'GET', '/api/fair/history?limit=10');
      assert.equal(h.status, 200);
      const rolls = h.data.rolls.filter(x => x.serverHash);
      assert.ok(rolls.length >= 4, 'recent bets carry fairness coordinates');
      for (const roll of rolls) {
        assert.equal(typeof roll.nonce, 'number');
        assert.match(roll.serverHash, /^[a-f0-9]{64}$/);
        assert.ok(roll.clientSeed && roll.clientSeed.length > 0);
      }
    });

    await t.test('the revealed seed re-derives a past bet and matches its commitment', async () => {
      const before = (await req(s, 'GET', '/api/fair/history?limit=10')).data.rolls.filter(x => x.serverHash);
      const bet = before[before.length - 1]; // an older bet on this seed

      const rot = await req(s, 'POST', '/api/fair/rotate');
      assert.equal(rot.status, 200);
      const revealedSeed = rot.data.revealedSeed;

      // The seed committed to for that bet is exactly the one just revealed.
      assert.equal(bet.serverHash, rot.data.revealedHash, 'bet commitment equals revealed hash');
      assert.equal(fair.sha256Hex(revealedSeed), bet.serverHash, 'sha256(revealedSeed) reproduces the commitment');

      // And the floats for that bet are deterministic from the revealed inputs.
      const a = fair.floatsFrom(revealedSeed, bet.clientSeed, bet.nonce, 8);
      const b = fair.floatsFrom(revealedSeed, bet.clientSeed, bet.nonce, 8);
      assert.deepEqual(a, b);
      assert.equal(a.length, 8);
      assert.ok(a.every(f => f >= 0 && f < 1));
    });
  } finally {
    child.kill('SIGTERM');
    rmDb();
  }
});
