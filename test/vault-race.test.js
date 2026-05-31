'use strict';

// Integration test for the double-credit prevention fix in confirmDeposit.
// Spawns the server as a child process on an ephemeral port, fires N
// parallel confirms against the same depositId, asserts exactly one credit.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const REPO = path.join(__dirname, '..');
const PORT = 6090 + (process.pid % 100);
const DB = `/tmp/crypt-test-race-${process.pid}.db`;
try { fs.unlinkSync(DB); } catch (_) {}

function waitForReady(url, timeoutMs = 10_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const r = await fetch(url);
        if (r.ok) return resolve();
      } catch (_) {}
      if (Date.now() - start > timeoutMs) return reject(new Error('server did not start within ' + timeoutMs + 'ms'));
      setTimeout(tick, 150);
    };
    tick();
  });
}

test('parallel /api/vault/confirm credits exactly once', async () => {
  const child = spawn(process.execPath, [path.join(REPO, 'server/index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: DB,
      SECURE_COOKIES: '0',
      SESSION_SECRET: 'test-' + Math.random().toString(36),
      RATE_API_MAX: '100000',
      STARTING_BALANCE: '10000'
    },
    stdio: ['ignore', 'ignore', 'inherit']
  });

  try {
    await waitForReady(`http://localhost:${PORT}/healthz`);

    const BASE = `http://localhost:${PORT}`;
    let csrf = '', cookieJar = '';
    async function req(method, p, body) {
      const headers = { Cookie: cookieJar };
      if (body) headers['Content-Type'] = 'application/json';
      if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
      const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
      const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      for (const s of sc) {
        const [pair] = s.split(';');
        const [k, v] = pair.split('=');
        if (k === 'csrf') csrf = v;
        cookieJar = (cookieJar ? cookieJar + '; ' : '') + pair;
      }
      let data = null; try { data = await r.json(); } catch (_) {}
      return { status: r.status, data };
    }

    await req('GET', '/api/me');
    const u = 'race' + Date.now().toString(36);
    let r = await req('POST', '/api/auth/register', { username: u, password: 'pwdpwdpwd1' });
    assert.equal(r.status, 200);
    const startBal = r.data.user.balance;

    r = await req('POST', '/api/vault/deposit', { currency: 'USDT', amount: 10 });
    assert.equal(r.status, 200);
    const depId = r.data.depositId;
    const credit = r.data.funCredited;

    const parallel = await Promise.all(
      Array(15).fill(0).map(() => req('POST', '/api/vault/confirm', { depositId: depId }))
    );
    const wins = parallel.filter(x => x.status === 200).length;
    const conflicts = parallel.filter(x => x.status === 409).length;

    assert.equal(wins, 1, 'exactly one confirm should succeed');
    assert.equal(conflicts, 14, 'the other 14 should be 409 Deposit already settled');

    r = await req('GET', '/api/me');
    assert.equal(r.data.user.balance, startBal + credit, 'balance must reflect exactly ONE credit');
  } finally {
    child.kill('SIGTERM');
    try { fs.unlinkSync(DB); } catch (_) {}
    try { fs.unlinkSync(DB + '-shm'); } catch (_) {}
    try { fs.unlinkSync(DB + '-wal'); } catch (_) {}
  }
});
