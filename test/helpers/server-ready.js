'use strict';

/* Shared helper: wait for a spawned server to accept requests.
 *
 * Every integration test spawns `server/index.js` and polls /healthz. The first
 * one to run pays the whole cold-start cost on a fresh CI runner — Node boot,
 * the native modules (better-sqlite3, argon2), express + the SDK, then schema
 * init — before the port opens. Locally that's ~200ms, but a cold, contended
 * runner can take far longer, and a tight timeout turns that into a phantom
 * "server did not start" failure with no diagnostic. (It flaked CI exactly that
 * way.) So:
 *   - poll generously; on success this returns as soon as the port answers, so
 *     a large ceiling costs nothing in the normal case;
 *   - if the child dies, reject immediately with its exit code and captured
 *     stderr instead of blind-waiting for the timeout;
 *   - on timeout, report how long we actually waited.
 */

const DEFAULT_TIMEOUT_MS = Number(process.env.TEST_SERVER_TIMEOUT_MS) || 60_000;

function waitForReady(url, opts) {
  // Back-compat: a bare number is a timeout.
  const o = typeof opts === 'number' ? { timeoutMs: opts } : (opts || {});
  const timeoutMs = o.timeoutMs || DEFAULT_TIMEOUT_MS;
  const child = o.child;
  const start = Date.now();

  // Capture stderr when the caller piped it, so a real crash is reportable.
  let stderr = '';
  if (child && child.stderr) child.stderr.on('data', (c) => { stderr += String(c); });

  let exited = null;
  if (child) child.once('exit', (code, signal) => { exited = { code, signal }; });

  return new Promise((resolve, reject) => {
    const fail = (msg) => {
      const waited = Date.now() - start;
      const tail = stderr.trim().split('\n').slice(-15).join('\n');
      reject(new Error(`${msg} (waited ${waited}ms)${tail ? `\n--- server stderr ---\n${tail}` : ''}`));
    };
    const tick = async () => {
      try { const r = await fetch(url); if (r.ok) return resolve(); } catch (_) { /* not up yet */ }
      if (exited) return fail(`server exited before becoming ready (code=${exited.code}, signal=${exited.signal})`);
      if (Date.now() - start > timeoutMs) return fail('server did not start');
      setTimeout(tick, 150);
    };
    tick();
  });
}

module.exports = { waitForReady, DEFAULT_TIMEOUT_MS };
