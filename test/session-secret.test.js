'use strict';

// A weak SESSION_SECRET makes every HMAC-signed session token forgeable, so the
// server must refuse to boot on one in a real (SECURE_COOKIES=1) deployment,
// while still coming up in local dev (with a warning) so developers aren't
// blocked.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { waitForReady } = require('./helpers/server-ready');

const REPO = path.join(__dirname, '..');
const PORT = 7700 + (process.pid % 100);   // unique base — see test/ports.test.js
const BASE = `http://localhost:${PORT}`;
const DB = `/tmp/crypt-test-secret-${process.pid}.db`;

function rmDb() { for (const f of [DB, DB + '-shm', DB + '-wal']) { try { fs.unlinkSync(f); } catch (_) {} } }
function boot(env) {
  return spawn(process.execPath, [path.join(REPO, 'server/index.js')], {
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

test('a production deploy (SECURE_COOKIES=1) refuses to boot on a weak SESSION_SECRET', async () => {
  rmDb();
  const child = boot({ SESSION_SECRET: 'short', SECURE_COOKIES: '1' });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  try {
    const code = await new Promise((resolve) => {
      child.on('exit', (c) => resolve(c));
      setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, 15000).unref();
    });
    assert.equal(code, 1, 'must exit 1 rather than serve with a forgeable secret');
    assert.match(stderr, /SESSION_SECRET is only \d+ characters/, 'says why it refused');
  } finally {
    try { child.kill('SIGKILL'); } catch (_) {}
    rmDb();
  }
});

test('local dev (SECURE_COOKIES=0) still boots on a short secret, with a warning', async (t) => {
  rmDb();
  const child = boot({ SESSION_SECRET: 'short', SECURE_COOKIES: '0' });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  try {
    await waitForReady(`${BASE}/healthz`, { child });
    const h = await (await fetch(`${BASE}/healthz`)).json();
    assert.equal(h.ok, true, 'dev server comes up despite the weak secret');
    assert.match(stderr, /never ship this/i, 'warns loudly about the weak secret');
  } finally {
    child.kill('SIGTERM');
    rmDb();
  }
});
