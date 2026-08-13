'use strict';

/* Online presence — how many players are actually around right now.
 *
 * Deliberately in-memory and approximate: every authenticated request stamps
 * the user's id, and anyone seen inside the window counts as online. No DB
 * writes on the request path (this runs on EVERY request, so it has to be
 * free), and nothing to clean up on restart.
 *
 * Caveat worth knowing: this counts per process. A multi-instance deployment
 * would report each instance's own share rather than a global total, which
 * would need a shared store (Redis) or a periodic DB heartbeat.
 */

const WINDOW_MS = Number(process.env.PRESENCE_WINDOW_MS) || 5 * 60 * 1000;
const seen = new Map(); // userId -> last-seen ms

function touch(userId) {
  if (userId == null) return;
  seen.set(Number(userId), Date.now());
}

function sweep(now = Date.now()) {
  for (const [id, ts] of seen) if (now - ts > WINDOW_MS) seen.delete(id);
}

function count(now = Date.now()) {
  sweep(now);
  return seen.size;
}

// Periodic sweep so an idle server doesn't hold ids forever. unref'd so it
// never keeps the process (or a test run) alive.
const timer = setInterval(() => sweep(), Math.min(WINDOW_MS, 60_000));
if (timer.unref) timer.unref();

module.exports = { touch, count, WINDOW_MS, _seen: seen };
