'use strict';

const crypto = require('crypto');
const { db, sessionSecret } = require('./db');
const { ensureFair } = require('./fair');

const STARTING_CENTS = Math.round(Number(process.env.STARTING_BALANCE || 1000) * 100);
const COOKIE = 'ns_session';
const SECURE = process.env.SECURE_COOKIES === '1';
const MAX_AGE_DAYS = 30;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}
function verifyPassword(password, salt, expectedHash) {
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Stateless signed-cookie session: "userId.HMAC(userId)".
function signToken(userId) {
  const mac = crypto.createHmac('sha256', sessionSecret()).update(String(userId)).digest('hex');
  return `${userId}.${mac}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return null;
  const id = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expected = crypto.createHmac('sha256', sessionSecret()).update(id).digest('hex');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const userId = Number(id);
  return Number.isInteger(userId) ? userId : null;
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i < 0) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function setSessionCookie(res, userId) {
  const token = signToken(userId);
  const attrs = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${MAX_AGE_DAYS * 24 * 60 * 60}`
  ];
  if (SECURE) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}
function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

function publicUser(row) {
  return { id: row.id, username: row.username, balance: row.balance_cents / 100 };
}

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function register(username, password) {
  if (!USERNAME_RE.test(username || '')) {
    throw httpError(400, 'Username must be 3–20 chars: letters, numbers, underscore.');
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 200) {
    throw httpError(400, 'Password must be at least 6 characters.');
  }
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) throw httpError(409, 'That username is taken.');

  const { hash, salt } = hashPassword(password);
  const info = db.prepare(
    'INSERT INTO users(username, pass_hash, pass_salt, balance_cents, created_at) VALUES(?,?,?,?,?)'
  ).run(username, hash, salt, STARTING_CENTS, Date.now());
  ensureFair(info.lastInsertRowid);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

function login(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.pass_salt, user.pass_hash)) {
    throw httpError(401, 'Invalid username or password.');
  }
  return user;
}

// Express middleware: attaches req.user (full row) or 401s if required.
function authenticate(req, res, next) {
  const cookies = parseCookies(req);
  const userId = verifyToken(cookies[COOKIE]);
  if (userId != null) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (user) req.user = user;
  }
  next();
}
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
  next();
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = {
  register, login, authenticate, requireAuth,
  setSessionCookie, clearSessionCookie, publicUser, httpError
};
