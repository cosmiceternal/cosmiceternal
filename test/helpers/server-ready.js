'use strict';

/* Shared helper: wait for a spawned server to accept requests.
 *
 * Every integration test spawns `server/index.js` and polls /healthz. The first
 * one to run pays the whole cold-start cost on a fresh CI runner — Node boot,
 * the native modules (better-sqlite3, argon2), express + the SDK, then schema
 * init — before the port opens. Locally that's ~200ms, but a cold, contended
 * runner can take far longer, and a tight timeout turns that into a phantom
 * "server did not start" failure with no diagnostic. (It flaked CI exactly that
 * way, twice.) So:
 *   - poll generously; on success this returns as soon as the port answers, so
 *     a large ceiling costs nothing in the normal case;
 *   - if the child dies, reject immediately with its exit code and captured
 *     output instead of blind-waiting for the timeout;
 *   - on timeout, say how long we waited, what the last connection attempt
 *     actually failed with, and everything the child printed.
 *
 * That last part is the whole point: a timeout with no evidence is
 * undebuggable. `ECONNREFUSED` for the full window means the process never
 * reached `app.listen` — compare against its log to see how far boot got.
 * Anything else (a timed-out request, a 503) means the port is open and the
 * server itself is wedged. Spawn with `stdio: ['ignore', 'pipe', 'pipe']` so
 * there is something to report; 'inherit' throws the evidence away.
 */

const DEFAULT_TIMEOUT_MS = Number(process.env.TEST_SERVER_TIMEOUT_MS) || 60_000;
// Per-attempt ceiling: a socket that connects but never answers must not stall
// the poll loop past the overall deadline.
const ATTEMPT_MS = 3_000;
const KEEP_CHARS = 4_000;   // tail of child output worth reporting

function waitForReady(url, opts) {
  // Back-compat: a bare number is a timeout.
  const o = typeof opts === 'number' ? { timeoutMs: opts } : (opts || {});
  const timeoutMs = o.timeoutMs || DEFAULT_TIMEOUT_MS;
  const child = o.child;
  const start = Date.now();

  // Capture whatever the caller piped, so a real crash or a stalled boot is
  // reportable. Draining these also keeps the child from blocking on a full
  // pipe buffer.
  const log = { stdout: '', stderr: '' };
  const sip = (key, stream) => {
    if (!stream) return;
    stream.setEncoding('utf8');
    stream.on('data', (c) => {
      log[key] = (log[key] + c).slice(-KEEP_CHARS);
    });
    stream.on('error', () => {});
  };
  if (child) { sip('stdout', child.stdout); sip('stderr', child.stderr); }

  let exited = null;
  if (child) child.once('exit', (code, signal) => { exited = { code, signal }; });

  let lastErr = 'none yet';

  return new Promise((resolve, reject) => {
    const fail = (msg) => {
      const waited = Date.now() - start;
      const parts = [`${msg} (waited ${waited}ms; last attempt: ${lastErr})`];
      if (!child || (!child.stdout && !child.stderr)) {
        parts.push('[no child output captured — spawn with stdio: [\'ignore\', \'pipe\', \'pipe\']]');
      }
      for (const k of ['stdout', 'stderr']) {
        if (log[k].trim()) parts.push(`--- server ${k} ---\n${log[k].trim()}`);
        else if (child && child[k]) parts.push(`--- server ${k}: (empty) ---`);
      }
      reject(new Error(parts.join('\n')));
    };
    const tick = async () => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(ATTEMPT_MS) });
        if (r.ok) return resolve();
        lastErr = `HTTP ${r.status}`;
      } catch (e) {
        lastErr = (e && (e.cause && e.cause.code)) || (e && e.name === 'TimeoutError' ? 'request timed out' : null) ||
          (e && e.code) || (e && e.message) || String(e);
      }
      if (exited) return fail(`server exited before becoming ready (code=${exited.code}, signal=${exited.signal})`);
      if (Date.now() - start > timeoutMs) return fail('server did not start');
      setTimeout(tick, 150);
    };
    tick();
  });
}

module.exports = { waitForReady, DEFAULT_TIMEOUT_MS };
