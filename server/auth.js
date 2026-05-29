'use strict';

const crypto = require('crypto');
const argon2 = require('argon2');
const db = require('./db');
const { ensureFair } = require('./fair');

const STARTING_CENTS = Math.round(Number(process.env.STARTING_BALANCE || 1000) * 100);
const COOKIE = 'cs_session';
const LEGACY_COOKIE = 'ns_session';
const SECURE = process.env.SECURE_COOKIES === '1';
const MAX_AGE_DAYS = 30;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const MIN_PASSWORD = 8;
const LOCKOUT_THRESHOLD = Number(process.env.LOCKOUT_THRESHOLD || 5);
const LOCKOUT_WINDOW_MS = Number(process.env.LOCKOUT_WINDOW_MS || 15 * 60 * 1000);
// A short, blunt blocklist for the most-guessed passwords. Not a full dictionary
// (intentionally — that belongs in a dedicated service like HIBP), just enough
// to block the worst foot-guns.
const PASSWORD_BLOCKLIST = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwerty12', 'qwertyui', 'iloveyou', 'admin123', 'letmein1', 'welcome1',
  'monkey123', 'abc12345', 'sunshine', 'princess', 'football', 'baseball',
  'master12', 'shadow12', 'starwars', 'changeme'
]);

// Argon2id (current OWASP recommendation); parameters tuned for ~50-100ms hash
// on a typical server. Costs scale automatically — bumping memoryCost later
// rehashes lazily on next successful login.
const ARGON_OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

async function hashPassword(password) { return argon2.hash(password, ARGON_OPTS); }

async function verifyPassword(stored, password) {
  if (!stored) return false;
  // New format: a single argon2 hash string starting with $argon2.
  if (typeof stored === 'string' && stored.startsWith('$argon2')) {
    try { return await argon2.verify(stored, password); } catch (_) { return false; }
  }
  return false;
}
// Legacy verify: prior versions stored scrypt(hash) + a separate salt.
function verifyLegacyScrypt(password, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
// Returns true if the password matches the user's stored hash (argon2 or legacy
// scrypt). False on missing user, missing hash, or any verify failure.
async function checkPassword(user, password) {
  if (!user || !user.pass_hash) return false;
  if (user.pass_hash.startsWith('$argon2')) return verifyPassword(user.pass_hash, password);
  return verifyLegacyScrypt(password, user.pass_salt, user.pass_hash);
}
// Enforce the shared password policy. Throws an httpError; otherwise returns.
function validatePasswordPolicy(password, username) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > 200) {
    throw httpError(400, `Password must be at least ${MIN_PASSWORD} characters.`);
  }
  if (PASSWORD_BLOCKLIST.has(password.toLowerCase())) {
    throw httpError(400, 'That password is too common — pick something less guessable.');
  }
  if (username && password.toLowerCase().includes(username.toLowerCase())) {
    throw httpError(400, 'Password must not contain your username.');
  }
}

// Stateless signed-cookie session: "userId.HMAC(userId)".
function signToken(userId) {
  const mac = crypto.createHmac('sha256', db.sessionSecret()).update(String(userId)).digest('hex');
  return `${userId}.${mac}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return null;
  const id = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expected = crypto.createHmac('sha256', db.sessionSecret()).update(id).digest('hex');
  const a = Buffer.from(mac), b = Buffer.from(expected);
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
    'HttpOnly', 'Path=/', 'SameSite=Lax',
    `Max-Age=${MAX_AGE_DAYS * 24 * 60 * 60}`
  ];
  if (SECURE) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}
function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
  res.append('Set-Cookie', `${LEGACY_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

function publicUser(row) {
  return {
    id: Number(row.id),
    username: row.username,
    balance: Number(row.balance_cents) / 100,
    xp: Number(row.xp || 0),
    level: Number(row.level || 1),
    streakDay: Number(row.streak_day || 0)
  };
}

async function getUserById(id) {
  const { rows } = await db.query('SELECT * FROM users WHERE id = ?', [id]);
  return rows[0] || null;
}

// ---- Audit log & login attempts (queryable security telemetry) ----
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.ip || req.socket?.remoteAddress || '').toString().split(',')[0].trim();
}
async function logAudit(req, event, userId, meta) {
  try {
    await db.query(
      'INSERT INTO audit_log(event, user_id, ip, ua, meta, created_at) VALUES(?,?,?,?,?,?)',
      [event, userId || null, clientIp(req), (req.headers['user-agent'] || '').slice(0, 240), meta ? JSON.stringify(meta) : null, Date.now()]
    );
  } catch (_) { /* never block a request on audit-log write failures */ }
}
async function logLoginAttempt(username, ip, success) {
  try {
    await db.query('INSERT INTO login_attempts(username, ip, success, created_at) VALUES(?,?,?,?)',
      [username, ip, success ? 1 : 0, Date.now()]);
  } catch (_) {}
}
async function recentFailedLogins(username) {
  const { rows } = await db.query(
    'SELECT COUNT(*) AS n FROM login_attempts WHERE username = ? AND success = 0 AND created_at > ?',
    [username, Date.now() - LOCKOUT_WINDOW_MS]
  );
  return Number(rows[0]?.n || 0);
}

async function register(req, username, password) {
  if (!USERNAME_RE.test(username || '')) {
    throw httpError(400, 'Username must be 3–20 chars: letters, numbers, underscore.');
  }
  validatePasswordPolicy(password, username);
  const existing = await db.query('SELECT id FROM users WHERE username = ?', [username]);
  if (existing.rows.length) throw httpError(409, 'That username is taken.');

  const hash = await hashPassword(password);
  const ins = await db.query(
    'INSERT INTO users(username, pass_hash, pass_salt, balance_cents, created_at) VALUES(?,?,?,?,?) RETURNING id',
    [username, hash, '', STARTING_CENTS, Date.now()]
  );
  const id = ins.rows[0].id;
  await ensureFair(id);
  logAudit(req, 'user.register', id, { username });
  return getUserById(id);
}

async function login(req, username, password) {
  username = (username || '').toString();
  const ip = clientIp(req);
  // Lockout check BEFORE we even peek at password to avoid leaking timing.
  if (USERNAME_RE.test(username)) {
    const fails = await recentFailedLogins(username);
    if (fails >= LOCKOUT_THRESHOLD) {
      logAudit(req, 'auth.lockout_hit', null, { username, fails });
      throw httpError(429, `Too many failed attempts. Try again in ${Math.ceil(LOCKOUT_WINDOW_MS / 60000)} minutes.`);
    }
  }
  const { rows } = await db.query('SELECT * FROM users WHERE username = ?', [username]);
  const user = rows[0];
  let ok = false;
  if (user) {
    ok = await checkPassword(user, password);
    // Transparent rehash to argon2id whenever a legacy scrypt account logs in.
    if (ok && !user.pass_hash.startsWith('$argon2')) {
      try {
        const upgraded = await hashPassword(password);
        await db.query('UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?', [upgraded, '', user.id]);
      } catch (_) {}
    }
  } else {
    // Burn time so timing doesn't leak whether the username exists.
    try { await argon2.verify('$argon2id$v=19$m=19456,t=2,p=1$YWFhYWFhYWFhYWFhYWFhYQ$Yu0YyVN05F5cV6PvoKjklj0z4j1uTl1z3a9JxRZ3X7M', password); } catch (_) {}
  }
  logLoginAttempt(username, ip, ok);
  if (!ok) {
    logAudit(req, 'auth.login_fail', user?.id, { username });
    throw httpError(401, 'Invalid username or password.');
  }
  logAudit(req, 'auth.login_success', user.id, { username });
  return user;
}

async function changePassword(req, userId, currentPassword, newPassword) {
  const { rows } = await db.query('SELECT * FROM users WHERE id = ?', [userId]);
  const user = rows[0];
  if (!user) throw httpError(404, 'User not found.');
  // Prove session ownership FIRST so a user who fat-fingers their current
  // password sees that error before being told their new one is too common.
  if (!await checkPassword(user, currentPassword)) {
    logAudit(req, 'auth.password_change_fail', userId, null);
    throw httpError(401, 'Current password is incorrect.');
  }
  validatePasswordPolicy(newPassword, user.username);
  const hash = await hashPassword(newPassword);
  await db.query('UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?', [hash, '', userId]);
  logAudit(req, 'auth.password_change', userId, null);
  return true;
}

async function userAuditLog(userId, limit = 25) {
  limit = Math.max(1, Math.min(100, Number(limit) || 25));
  const { rows } = await db.query(
    'SELECT event, ip, ua, meta, created_at FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    [userId, limit]
  );
  return rows.map(r => ({
    event: r.event, ip: r.ip, ua: r.ua,
    meta: r.meta ? safeJSON(r.meta) : null,
    ts: Number(r.created_at)
  }));
}
function safeJSON(s) { try { return JSON.parse(s); } catch { return null; } }

// Express middleware: attaches req.user (full row) when a valid session exists.
async function authenticate(req, res, next) {
  try {
    const cookies = parseCookies(req);
    const token = cookies[COOKIE] || cookies[LEGACY_COOKIE];
    const userId = verifyToken(token);
    if (userId != null) {
      const user = await getUserById(userId);
      if (user) req.user = user;
    }
  } catch (e) { /* ignore — treated as logged out */ }
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
  register, login, changePassword, userAuditLog,
  authenticate, requireAuth, getUserById,
  setSessionCookie, clearSessionCookie, publicUser, httpError,
  logAudit, clientIp,
  COOKIE, LEGACY_COOKIE, SECURE,
  parseCookies, signToken, verifyToken
};
