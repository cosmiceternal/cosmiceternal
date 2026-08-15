'use strict';

/* Direct messages — private 1-on-1 player-to-player mail.
 *
 * The lobby chat (chat.js) is one shared public room; this is the opposite:
 * a private thread between exactly two accounts. Same stack constraints apply
 * (poll-based, no websockets), and the same safety posture as chat: text is
 * stored raw and rendered with textContent on the client, so no HTML ever
 * executes, and a per-user token bucket throttles flooding independently of
 * the per-IP API limiter.
 *
 * A conversation is keyed by a canonical `pair_key` — the two user ids sorted
 * "low:high" — so both directions of a thread share one key. That makes thread
 * reads, unread counts, and per-conversation trimming a single indexed lookup
 * regardless of who sent which message.
 */

const db = require('./db');
const { httpError } = require('./auth');

const MAX_LEN = 500;              // DMs run a little longer than lobby one-liners
const KEEP_PER_PAIR = 400;        // messages retained per conversation
const BURST = 8;                  // messages per window per sender
const WINDOW_MS = 15_000;

const buckets = new Map();        // userId -> [timestamps]
const sweeper = setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [k, arr] of buckets) {
    const live = arr.filter(t => t > cutoff);
    if (live.length) buckets.set(k, live); else buckets.delete(k);
  }
}, 60_000);
if (sweeper.unref) sweeper.unref();

function checkRate(userId) {
  const now = Date.now();
  const arr = (buckets.get(userId) || []).filter(t => t > now - WINDOW_MS);
  if (arr.length >= BURST) throw httpError(429, 'Slow down — a few seconds between messages.');
  arr.push(now);
  buckets.set(userId, arr);
}

function sanitize(text) {
  if (typeof text !== 'string') throw httpError(400, 'Message required.');
  // Strip control chars (keeps emoji and all printable unicode). Done by code
  // point so no literal control character ever appears in this source file.
  let clean = '';
  for (const ch of text) {
    const c = ch.codePointAt(0);
    clean += (c < 0x20 || c === 0x7f) ? ' ' : ch;
  }
  clean = clean.trim();
  if (!clean) throw httpError(400, 'Message is empty.');
  if (clean.length > MAX_LEN) throw httpError(400, `Max ${MAX_LEN} characters.`);
  return clean;
}

// Canonical, direction-independent conversation key: "min:max".
function pairKey(a, b) {
  a = Number(a); b = Number(b);
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

// Resolve a username to its row (exact match — usernames are the identity and
// their unique index is case-sensitive). Throws a clean 4xx if missing.
async function resolveUser(username) {
  if (typeof username !== 'string' || !username.trim()) throw httpError(400, 'Who do you want to message?');
  const { rows } = await db.query('SELECT id, username, level FROM users WHERE username = ?', [username.trim()]);
  if (!rows.length) throw httpError(404, 'No player by that name.');
  return rows[0];
}

async function send(fromId, toUsername, text) {
  const clean = sanitize(text);
  checkRate(fromId);
  const to = await resolveUser(toUsername);
  if (Number(to.id) === Number(fromId)) throw httpError(400, "You can't message yourself.");
  const key = pairKey(fromId, to.id);
  await db.query(
    'INSERT INTO dm_messages(pair_key, from_user, to_user, text, created_at) VALUES(?,?,?,?,?)',
    [key, fromId, to.id, clean, Date.now()]
  );
  // Opportunistic per-conversation trim — keep each thread bounded without a
  // scheduled job, and without letting one busy pair evict another's history.
  await db.query(
    'DELETE FROM dm_messages WHERE pair_key = ? AND id < (SELECT COALESCE(MIN(id), 0) FROM (SELECT id FROM dm_messages WHERE pair_key = ? ORDER BY id DESC LIMIT ?) keep)',
    [key, key, KEEP_PER_PAIR]
  ).catch(() => {});
  return { ok: true, to: to.username };
}

// The inbox: one row per conversation, newest first, each with the last message
// and how many of its messages are still unread by me.
async function conversations(userId, limit = 40) {
  limit = Math.min(80, Math.max(1, Number(limit) || 40));

  // Newest message id per conversation I'm part of.
  const latest = await db.query(
    `SELECT pair_key, MAX(id) AS mid
       FROM dm_messages
      WHERE from_user = ? OR to_user = ?
      GROUP BY pair_key
      ORDER BY mid DESC
      LIMIT ?`,
    [userId, userId, limit]
  );
  if (!latest.rows.length) return { conversations: [], unread: 0 };

  // The actual last-message rows for those ids.
  const mids = latest.rows.map(r => Number(r.mid));
  const midPlaceholders = mids.map(() => '?').join(',');
  const msgs = await db.query(
    `SELECT id, from_user, to_user, text, created_at FROM dm_messages WHERE id IN (${midPlaceholders})`,
    mids
  );
  const msgById = new Map(msgs.rows.map(r => [Number(r.id), r]));

  // The partner in each conversation, and their public display bits.
  const partnerIds = new Set();
  for (const r of msgs.rows) {
    partnerIds.add(Number(r.from_user) === Number(userId) ? Number(r.to_user) : Number(r.from_user));
  }
  const pidList = [...partnerIds];
  const pidPlaceholders = pidList.map(() => '?').join(',');
  const users = await db.query(
    `SELECT id, username, level FROM users WHERE id IN (${pidPlaceholders})`,
    pidList
  );
  const userById = new Map(users.rows.map(u => [Number(u.id), u]));

  // Unread counts per conversation (messages addressed to me, still unread).
  // Not limited to this page, so summing it gives the true global unread total.
  const unreadRows = await db.query(
    'SELECT pair_key, COUNT(*) AS n FROM dm_messages WHERE to_user = ? AND read_at IS NULL GROUP BY pair_key',
    [userId]
  );
  const unreadByPair = new Map(unreadRows.rows.map(r => [r.pair_key, Number(r.n)]));

  const list = latest.rows.map(l => {
    const m = msgById.get(Number(l.mid));
    const partnerId = Number(m.from_user) === Number(userId) ? Number(m.to_user) : Number(m.from_user);
    const u = userById.get(partnerId) || { username: '(unknown)', level: 1 };
    return {
      user: u.username,
      level: Number(u.level || 1),
      last: m.text,
      lastMine: Number(m.from_user) === Number(userId),
      ts: Number(m.created_at),
      unread: unreadByPair.get(l.pair_key) || 0
    };
  });
  const unread = [...unreadByPair.values()].reduce((a, b) => a + b, 0);
  return { conversations: list, unread };
}

// A single thread with `otherUsername`, oldest→newest, optionally only ids past
// `sinceId` so the client can poll incrementally.
async function thread(userId, otherUsername, sinceId = 0, limit = 60) {
  const other = await resolveUser(otherUsername);
  if (Number(other.id) === Number(userId)) throw httpError(400, "That's you.");
  limit = Math.min(100, Math.max(1, Number(limit) || 60));
  const since = Math.max(0, Number(sinceId) || 0);
  const key = pairKey(userId, other.id);
  const { rows } = await db.query(
    `SELECT id, from_user, to_user, text, created_at, read_at
       FROM dm_messages
      WHERE pair_key = ? AND id > ?
      ORDER BY id DESC LIMIT ?`,
    [key, since, limit]
  );
  return {
    partner: { user: other.username, level: Number(other.level || 1) },
    messages: rows.reverse().map(r => ({
      id: Number(r.id),
      mine: Number(r.from_user) === Number(userId),
      text: r.text,
      ts: Number(r.created_at),
      read: r.read_at != null
    }))
  };
}

// Mark every message the other person sent me in this thread as read.
async function markRead(userId, otherUsername) {
  const other = await resolveUser(otherUsername);
  const key = pairKey(userId, other.id);
  const r = await db.query(
    'UPDATE dm_messages SET read_at = ? WHERE pair_key = ? AND to_user = ? AND read_at IS NULL',
    [Date.now(), key, userId]
  );
  return { ok: true, marked: r.rowCount || 0 };
}

// Cheap global unread total — the endpoint the badge polls.
async function unreadCount(userId) {
  const { rows } = await db.query(
    'SELECT COUNT(*) AS n FROM dm_messages WHERE to_user = ? AND read_at IS NULL',
    [userId]
  );
  return { unread: Number(rows[0]?.n || 0) };
}

module.exports = { send, conversations, thread, markRead, unreadCount, MAX_LEN };
