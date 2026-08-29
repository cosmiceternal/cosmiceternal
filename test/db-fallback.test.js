'use strict';

// A configured-but-unreachable Postgres must not take the whole site down.
//
// Render deploys were failing with "Exited with status 1 while running your
// code": DATABASE_URL pointed at a free-tier Postgres that had gone away, and
// db.init() rejected, so the process exited before ever listening. Visitors got
// nothing at all. init() now retries, then degrades to SQLite and keeps
// serving, reporting the downgrade on /healthz.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { waitForReady } = require('./helpers/server-ready');

const REPO = path.join(__dirname, '..');
const PORT = 7400 + (process.pid % 100);   // unique base — see test/ports.test.js
const BASE = `http://localhost:${PORT}`;
const DB = `/tmp/crypt-test-fallback-${process.pid}.db`;
// A port nothing listens on, so the connection is refused immediately.
const DEAD_PG = 'postgresql://nobody:nobody@127.0.0.1:5599/missing';

function rmDb() { for (const f of [DB, DB + '-shm', DB + '-wal']) { try { fs.unlinkSync(f); } catch (_) {} } }

function boot(extraEnv) {
  return spawn(process.execPath, [path.join(REPO, 'server/index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT), DB_PATH: DB, SESSION_SECRET: 'fallback-test',
      SECURE_COOKIES: '0', RATE_API_MAX: '100000', RATE_AUTH_MAX: '100000',
      STARTING_BALANCE: '1000',
      DB_CONNECT_ATTEMPTS: '1', DB_CONNECT_TIMEOUT_MS: '1500',
      ...extraEnv
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
}

test('an unreachable Postgres degrades to SQLite instead of killing the site', async (t) => {
  rmDb();
  const child = boot({ DATABASE_URL: DEAD_PG });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  try {
    // The site must actually come up and serve.
    await waitForReady(`${BASE}/healthz`, { child });

    const health = await (await fetch(`${BASE}/healthz`)).json();
    assert.equal(health.ok, true, 'server is healthy');
    assert.equal(health.storage, 'sqlite', 'fell back to SQLite');
    assert.equal(health.degraded, true, 'reports itself as degraded');
    assert.match(health.reason || '', /postgres-unreachable/, 'says why');

    // The degradation must be loud in the logs, not silent.
    assert.match(stderr, /Postgres could not be reached/i, 'logs the failure');
    assert.match(stderr, /EPHEMERAL/, 'warns that the fallback disk is ephemeral');

    await t.test('the casino is genuinely playable while degraded', async () => {
      const jar = {}; let csrf = '';
      const rec = (r) => {
        const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
        for (const s of sc) {
          const [pair] = s.split(';'); const [k, ...v] = pair.split('=');
          jar[k.trim()] = v.join('='); if (k.trim() === 'csrf') csrf = v.join('=');
        }
      };
      const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      const post = async (p, body) => {
        const r = await fetch(BASE + p, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie(), 'X-CSRF-Token': csrf },
          body: JSON.stringify(body)
        });
        rec(r);
        return { status: r.status, data: await r.json().catch(() => null) };
      };
      rec(await fetch(`${BASE}/api/me`));

      const reg = await post('/api/auth/register', { username: 'degraded1', password: 'longpassword1' });
      assert.equal(reg.status, 200, 'a new player can still register: ' + JSON.stringify(reg.data));

      const bet = await post('/api/play/dice', { bet: 1, target: 50, dir: 'over' });
      assert.equal(bet.status, 200, 'a wager still settles: ' + JSON.stringify(bet.data));

      const me = await (await fetch(`${BASE}/api/me`, { headers: { Cookie: cookie() } })).json();
      assert.ok(me.user && me.user.balance > 0, 'balance is readable');
    });
  } finally {
    child.kill('SIGTERM');
    rmDb();
  }
});

test('DB_FALLBACK=0 keeps the old fail-fast behaviour', async () => {
  rmDb();
  const child = boot({ DATABASE_URL: DEAD_PG, DB_FALLBACK: '0' });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  try {
    const code = await new Promise((resolve) => {
      child.on('exit', (c) => resolve(c));
      setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, 25000).unref();
    });
    assert.equal(code, 1, 'exits 1 rather than degrading');
    assert.match(stderr, /Failed to initialize/, 'says it could not start');
  } finally {
    try { child.kill('SIGTERM'); } catch (_) {}
    rmDb();
  }
});
