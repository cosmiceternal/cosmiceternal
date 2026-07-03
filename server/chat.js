'use strict';

/* Lobby chat. Poll-based (no websockets in this stack — a 5s poll is plenty
 * for a casino lobby). Messages are stored raw and rendered with textContent
 * on the client, so no HTML ever executes. Per-user token bucket stops
 * flooding independently of the per-IP API limiter. */

const db = require('./db');
const { httpError } = require('./auth');

const MAX_LEN = 200;
const KEEP = 200;                 // rows kept in the table
const BURST = 5;                  // messages per window per user
const WINDOW_MS = 15_000;

const buckets = new Map();        // userId -> [timestamps]
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [k, arr] of buckets) {
    const live = arr.filter(t => t > cutoff);
    if (live.length) buckets.set(k, live); else buckets.delete(k);
  }
}, 60_000).unref();

function checkRate(userId) {
  const now = Date.now();
  const arr = (buckets.get(userId) || []).filter(t => t > now - WINDOW_MS);
  if (arr.length >= BURST) throw httpError(429, 'Slow down — a few seconds between messages.');
  arr.push(now);
  buckets.set(userId, arr);
}

function sanitize(text) {
  if (typeof text !== 'string') throw httpError(400, 'Message required.');
  // Strip control chars (keeps emoji and all printable unicode).
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!clean) throw httpError(400, 'Message is empty.');
  if (clean.length > MAX_LEN) throw httpError(400, `Max ${MAX_LEN} characters.`);
  return clean;
}

async function send(userId, text) {
  const clean = sanitize(text);
  checkRate(userId);
  await db.query('INSERT INTO chat_messages(user_id, text, created_at) VALUES(?,?,?)', [userId, clean, Date.now()]);
  // Opportunistic trim — keep the table small without a scheduled job.
  await db.query(
    'DELETE FROM chat_messages WHERE id < (SELECT COALESCE(MIN(id), 0) FROM (SELECT id FROM chat_messages ORDER BY id DESC LIMIT ?) keep)',
    [KEEP]
  ).catch(() => {});
  return { ok: true };
}

async function list(sinceId = 0, limit = 50) {
  limit = Math.min(100, Math.max(1, Number(limit) || 50));
  const since = Math.max(0, Number(sinceId) || 0);
  const { rows } = await db.query(
    `SELECT c.id, c.text, c.created_at, u.username, u.level
     FROM chat_messages c JOIN users u ON u.id = c.user_id
     WHERE c.id > ?
     ORDER BY c.id DESC LIMIT ?`,
    [since, limit]
  );
  return {
    messages: rows.reverse().map(r => ({
      id: Number(r.id),
      user: r.username,
      level: Number(r.level || 1),
      text: r.text,
      ts: Number(r.created_at)
    }))
  };
}

module.exports = { send, list, MAX_LEN };
