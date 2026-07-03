'use strict';

const path = require('path');
const express = require('express');
const compression = require('compression');

const crypto = require('crypto');
const db = require('./db');
const auth = require('./auth');
const fair = require('./fair');
const games = require('./games');
const vault = require('./vault');
const dealer = require('./dealer');
const progression = require('./progression');
const admin = require('./admin');
const chat = require('./chat');
const race = require('./race');
const limits = require('./limits');

const app = express();
const PORT = process.env.PORT || 3000;
// SECURE is owned by auth.js so the session, CSRF, and HSTS branches share
// one source of truth — surface it locally for readability.
const SECURE = auth.SECURE;

// Behind a hosting proxy (Render/Railway/Fly/Heroku/nginx) that terminates TLS.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(compression());

// Structured error/slow-request log: one line per 5xx or >1s request. No
// per-request noise — this is the signal an operator actually reads.
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - t0;
    if (res.statusCode >= 500 || ms > 1000) {
      console.log(JSON.stringify({
        t: new Date().toISOString(), method: req.method, path: req.path,
        status: res.statusCode, ms, user: req.user ? Number(req.user.id) : null
      }));
    }
  });
  next();
});

// ---------------- Security headers ----------------
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // games inject inline style="" via innerHTML
  "img-src 'self' data:",             // inline SVG favicon
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'"
].join('; ');
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(), usb=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('X-Download-Options', 'noopen');
  if (SECURE) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  next();
});

// ---------------- Rate limiting (in-memory, per-IP fixed window) ----------------
function limiter(windowMs, max) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, e] of hits) if (now > e.resetAt) hits.delete(k);
  }, windowMs);
  sweep.unref();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || 'unknown';
    let e = hits.get(key);
    if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + windowMs }; hits.set(key, e); }
    e.count++;
    if (e.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((e.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Please slow down a moment.' });
    }
    next();
  };
}
const apiLimiter = limiter(
  Number(process.env.RATE_API_WINDOW_MS) || 60_000,
  Number(process.env.RATE_API_MAX) || 300
);
const authLimiter = limiter(
  Number(process.env.RATE_AUTH_WINDOW_MS) || 900_000,
  Number(process.env.RATE_AUTH_MAX) || 40
);
// Per-IP rate limit on /api — except the CoinPayments IPN webhook, which is
// delivered from a small set of gateway IPs and would otherwise eat the budget
// during a retry storm and silently drop confirmations.
app.use('/api', (req, res, next) => {
  if (req.path === '/vault/webhook') return next();
  return apiLimiter(req, res, next);
});
app.use(['/api/auth/login', '/api/auth/register'], authLimiter);

// Lightweight health check for uptime monitors (must be before CSRF; GET only).
app.get('/healthz', async (req, res) => {
  try {
    await db.query('SELECT 1 AS ok');
    res.set('Cache-Control', 'no-store').json({ ok: true, ts: Date.now() });
  } catch (e) {
    res.status(503).json({ ok: false, error: 'db-unhealthy' });
  }
});

// Vault webhook is mounted BEFORE express.json + CSRF so the raw body is
// available for HMAC verification. The signature in the HMAC header is the
// auth — there's no session or CSRF on this path.
app.post('/api/vault/webhook',
  express.raw({ type: '*/*', limit: '32kb' }),
  async (req, res) => {
    try {
      req.rawBody = req.body; // express.raw leaves it as a Buffer
      const out = await vault.handleWebhook(req);
      if (!out.ok) return res.status(400).json({ error: out.reason || 'invalid' });
      res.json({ ok: true });
    } catch (e) {
      console.error('vault webhook:', e);
      res.status(500).json({ error: 'webhook-handler-failed' });
    }
  }
);

app.use(express.json({ limit: '32kb' }));

// API responses carry balances, audit rows, session state — never cache them
// (browser back button, shared proxies).
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// ---------------- CSRF (double-submit cookie) ----------------
// Every visitor gets a random `csrf` cookie (readable by JS so the client can
// echo it back in X-CSRF-Token on state-changing requests). SameSite=Lax on
// the session cookie already blocks cross-site POSTs in modern browsers; this
// is defence-in-depth and an explicit bar for any forged-form attack.
const CSRF_COOKIE = 'csrf';
const CSRF_TOKEN_RE = /^[a-f0-9]{32,128}$/;
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
function csrf(req, res, next) {
  const cookies = auth.parseCookies(req);
  let token = cookies[CSRF_COOKIE];
  if (!token || !CSRF_TOKEN_RE.test(token)) {
    token = crypto.randomBytes(32).toString('hex');
    const attrs = [`${CSRF_COOKIE}=${token}`, 'Path=/', 'SameSite=Lax', `Max-Age=${30 * 86400}`];
    if (SECURE) attrs.push('Secure');
    res.append('Set-Cookie', attrs.join('; '));
    cookies[CSRF_COOKIE] = token; // make available within this request
  }
  if (STATE_CHANGING.has(req.method)) {
    const header = req.headers['x-csrf-token'];
    if (!header || typeof header !== 'string' || !timingSafeEq(header, cookies[CSRF_COOKIE])) {
      auth.logAudit(req, 'security.csrf_fail', req.user?.id, { path: req.path });
      return res.status(403).json({ error: 'Invalid or missing CSRF token.' });
    }
  }
  next();
}
function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
app.use(csrf);
app.use(auth.authenticate);

// Wrap handlers so thrown/rejected httpErrors become JSON responses, and any
// progression delta the request accumulates (XP gained, level-ups, achievement
// unlocks) is merged into the response body automatically.
const h = (fn) => async (req, res) => {
  const store = { progress: null };
  try {
    const out = await progression.requestStore.run(store, () => fn(req, res));
    if (out !== undefined && !res.headersSent) {
      const merged = store.progress && typeof out === 'object'
        ? Object.assign({ progress: store.progress }, out)
        : out;
      res.json(merged);
    }
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) res.status(status).json({ error: e.message || 'Server error.' });
  }
};

// ---------------- Auth ----------------
app.post('/api/auth/register', h(async (req, res) => {
  const { username, password } = req.body || {};
  const user = await auth.register(req, username, password);
  auth.setSessionCookie(res, user.id, Number(user.session_epoch || 0));
  res.json({ user: auth.publicUser(user) });
}));

app.post('/api/auth/login', h(async (req, res) => {
  const { username, password } = req.body || {};
  const user = await auth.login(req, username, password);
  auth.setSessionCookie(res, user.id, Number(user.session_epoch || 0));
  res.json({ user: auth.publicUser(user) });
}));

app.post('/api/auth/logout', (req, res) => {
  auth.logAudit(req, 'auth.logout', req.user?.id, null);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.user ? auth.publicUser(req.user) : null });
});

app.post('/api/auth/password', auth.requireAuth, h(async (req, res) => {
  const { current, next } = req.body || {};
  const { newEpoch } = await auth.changePassword(req, req.user.id, current, next);
  // Every OTHER session just died (epoch bump) — re-issue this one so the
  // user who changed the password stays signed in.
  auth.setSessionCookie(res, req.user.id, newEpoch);
  return { ok: true };
}));

app.get('/api/auth/audit', auth.requireAuth, h(async (req) => ({
  events: await auth.userAuditLog(req.user.id, req.query.limit)
})));

// ---------------- Provably fair ----------------
app.get('/api/fair', auth.requireAuth, h((req) => fair.publicState(req.user.id)));
app.post('/api/fair/client', auth.requireAuth, h((req) => fair.setClientSeed(req.user.id, (req.body || {}).clientSeed)));
app.post('/api/fair/rotate', auth.requireAuth, h(async (req) => {
  const revealed = await fair.rotate(req.user.id);
  const state = await fair.publicState(req.user.id);
  return Object.assign({ state }, revealed);
}));
app.get('/api/fair/history', auth.requireAuth, h(async (req) => ({ rolls: await games.history(req.user.id, req.query.limit) })));

// ---------------- Games ----------------
app.post('/api/play/dice',   auth.requireAuth, h((req) => games.playDice(req.user.id, req.body || {})));
app.post('/api/play/plinko', auth.requireAuth, h((req) => games.playPlinko(req.user.id, req.body || {})));
app.post('/api/play/crash',  auth.requireAuth, h((req) => games.playCrash(req.user.id, req.body || {})));
app.post('/api/play/mines/start',   auth.requireAuth, h((req) => games.minesStart(req.user.id, req.body || {})));
app.post('/api/play/mines/reveal',  auth.requireAuth, h((req) => games.minesReveal(req.user.id, req.body || {})));
app.post('/api/play/mines/cashout', auth.requireAuth, h((req) => games.minesCashout(req.user.id, req.body || {})));

app.post('/api/play/limbo',  auth.requireAuth, h((req) => games.playLimbo(req.user.id, req.body || {})));
app.post('/api/play/wheel',  auth.requireAuth, h((req) => games.playWheel(req.user.id, req.body || {})));
app.get('/api/play/keno/table', auth.requireAuth, h((req) => games.kenoTable(req.query.picks)));
app.post('/api/play/keno',   auth.requireAuth, h((req) => games.playKeno(req.user.id, req.body || {})));
app.post('/api/play/roulette', auth.requireAuth, h((req) => games.playRoulette(req.user.id, req.body || {})));
app.post('/api/play/diamonds', auth.requireAuth, h((req) => games.playDiamonds(req.user.id, req.body || {})));
app.post('/api/play/slots',         auth.requireAuth, h((req) => games.playSlots(req.user.id, req.body || {})));
app.post('/api/play/luckysevens',   auth.requireAuth, h((req) => games.playLuckySevens(req.user.id, req.body || {})));
app.post('/api/play/cosmic',        auth.requireAuth, h((req) => games.playCosmicReels(req.user.id, req.body || {})));
app.post('/api/play/sicbo',  auth.requireAuth, h((req) => games.playSicbo(req.user.id, req.body || {})));
app.post('/api/play/color',  auth.requireAuth, h((req) => games.playColor(req.user.id, req.body || {})));
app.post('/api/play/scratch', auth.requireAuth, h((req) => games.playScratch(req.user.id, req.body || {})));

app.post('/api/play/hilo/start',   auth.requireAuth, h((req) => games.hiloStart(req.user.id, req.body || {})));
app.post('/api/play/hilo/guess',   auth.requireAuth, h((req) => games.hiloGuess(req.user.id, req.body || {})));
app.post('/api/play/hilo/cashout', auth.requireAuth, h((req) => games.hiloCashout(req.user.id, req.body || {})));

app.post('/api/play/towers/start',   auth.requireAuth, h((req) => games.towersStart(req.user.id, req.body || {})));
app.post('/api/play/towers/reveal',  auth.requireAuth, h((req) => games.towersReveal(req.user.id, req.body || {})));
app.post('/api/play/towers/cashout', auth.requireAuth, h((req) => games.towersCashout(req.user.id, req.body || {})));

app.post('/api/play/pump/start',   auth.requireAuth, h((req) => games.pumpStart(req.user.id, req.body || {})));
app.post('/api/play/pump/pump',    auth.requireAuth, h((req) => games.pumpPump(req.user.id, req.body || {})));
app.post('/api/play/pump/cashout', auth.requireAuth, h((req) => games.pumpCashout(req.user.id, req.body || {})));

app.post('/api/play/coin/start',   auth.requireAuth, h((req) => games.coinStart(req.user.id, req.body || {})));
app.post('/api/play/coin/flip',    auth.requireAuth, h((req) => games.coinFlip(req.user.id, req.body || {})));
app.post('/api/play/coin/cashout', auth.requireAuth, h((req) => games.coinCashout(req.user.id, req.body || {})));

app.post('/api/play/videopoker/start', auth.requireAuth, h((req) => games.videoPokerStart(req.user.id, req.body || {})));
app.post('/api/play/videopoker/draw',  auth.requireAuth, h((req) => games.videoPokerDraw(req.user.id, req.body || {})));

app.post('/api/play/blackjack/start',  auth.requireAuth, h((req) => games.blackjackStart(req.user.id, req.body || {})));
app.post('/api/play/blackjack/hit',    auth.requireAuth, h((req) => games.blackjackHit(req.user.id, req.body || {})));
app.post('/api/play/blackjack/stand',  auth.requireAuth, h((req) => games.blackjackStand(req.user.id, req.body || {})));
app.post('/api/play/blackjack/double', auth.requireAuth, h((req) => games.blackjackDouble(req.user.id, req.body || {})));

app.post('/api/play/baccarat',    auth.requireAuth, h((req) => games.playBaccarat(req.user.id, req.body || {})));
app.post('/api/play/dragontiger', auth.requireAuth, h((req) => games.playDragonTiger(req.user.id, req.body || {})));
app.post('/api/play/andarbahar',  auth.requireAuth, h((req) => games.playAndarBahar(req.user.id, req.body || {})));
app.post('/api/play/cascade',     auth.requireAuth, h((req) => games.playCascade(req.user.id, req.body || {})));
app.post('/api/play/war',         auth.requireAuth, h((req) => games.playWar(req.user.id, req.body || {})));
app.post('/api/play/pachinko',    auth.requireAuth, h((req) => games.playPachinko(req.user.id, req.body || {})));

app.post('/api/play/chicken/start',   auth.requireAuth, h((req) => games.chickenStart(req.user.id, req.body || {})));
app.post('/api/play/chicken/step',    auth.requireAuth, h((req) => games.chickenStep(req.user.id, req.body || {})));
app.post('/api/play/chicken/cashout', auth.requireAuth, h((req) => games.chickenCashout(req.user.id, req.body || {})));

app.post('/api/play/craps/start', auth.requireAuth, h((req) => games.crapsStart(req.user.id, req.body || {})));
app.post('/api/play/craps/roll',  auth.requireAuth, h((req) => games.crapsRoll(req.user.id, req.body || {})));

app.post('/api/play/tcp/start', auth.requireAuth, h((req) => games.tcpStart(req.user.id, req.body || {})));
app.post('/api/play/tcp/act',   auth.requireAuth, h((req) => games.tcpAct(req.user.id, req.body || {})));

app.post('/api/play/bingo', auth.requireAuth, h((req) => games.playBingo(req.user.id, req.body || {})));

app.post('/api/play/penalty/start',   auth.requireAuth, h((req) => games.penaltyStart(req.user.id, req.body || {})));
app.post('/api/play/penalty/shoot',   auth.requireAuth, h((req) => games.penaltyShoot(req.user.id, req.body || {})));
app.post('/api/play/penalty/cashout', auth.requireAuth, h((req) => games.penaltyCashout(req.user.id, req.body || {})));

// ---------------- Vault (crypto deposits) ----------------
app.get('/api/vault',          auth.requireAuth, h((req) => vault.publicSnapshot(req.user.id)));
app.post('/api/vault/deposit', auth.requireAuth, h((req) => vault.createDeposit(req, req.user.id, req.body || {})));
app.post('/api/vault/confirm', auth.requireAuth, h((req) => vault.confirmDeposit(req, req.user.id, req.body || {})));
app.post('/api/vault/cancel',  auth.requireAuth, h((req) => vault.cancelDeposit(req, req.user.id, req.body || {})));
app.get('/api/vault/history',  auth.requireAuth, h(async (req) => ({ deposits: await vault.listDeposits(req.user.id, req.query.limit) })));
app.post('/api/vault/withdraw',        auth.requireAuth, h((req) => vault.createWithdrawal(req, req.user.id, req.body || {})));
app.post('/api/vault/withdraw/cancel', auth.requireAuth, h((req) => vault.cancelWithdrawal(req, req.user.id, req.body || {})));
app.get('/api/vault/withdrawals',      auth.requireAuth, h(async (req) => ({ withdrawals: await vault.listWithdrawals(req.user.id, req.query.limit) })));

// ---------------- Social & economy ----------------
app.get('/api/jackpot', auth.requireAuth, h(() => games.jackpotState()));
app.get('/api/chat',      auth.requireAuth, h((req) => chat.list(req.query.since, req.query.limit)));
app.post('/api/chat/send', auth.requireAuth, h((req) => chat.send(req.user.id, (req.body || {}).text)));
app.get('/api/race', auth.requireAuth, h((req) => race.state(req.user.id)));

// ---------------- Responsible gaming ----------------
app.get( '/api/limits',              auth.requireAuth, h((req) => limits.state(req.user.id)));
app.post('/api/limits/loss-limit',   auth.requireAuth, h((req) => limits.setLossLimit(req, req.user.id, req.body || {})));
app.post('/api/limits/self-exclude', auth.requireAuth, h((req) => limits.selfExclude(req, req.user.id, req.body || {})));

// ---------------- Progression (XP, levels, streak, achievements) ----------------
app.get('/api/progression',                auth.requireAuth, h((req) => progression.snapshot(req.user.id)));
app.post('/api/progression/claim-daily',   auth.requireAuth, h((req) => progression.claimDaily(req.user.id)));

// ---------------- AI Dealer (live banter; falls back to scripted client-side when no API key) ----------------
const dealerLimiter = limiter(60_000, Number(process.env.RATE_DEALER_MAX || 30));
app.post('/api/dealer/line', dealerLimiter, auth.requireAuth, h((req) => dealer.line(req, req.body || {})));

// ---------------- History / stats ----------------
app.get('/api/history', auth.requireAuth, h(async (req) => ({ bets: await games.history(req.user.id, req.query.limit) })));
app.get('/api/stats',   auth.requireAuth, h((req) => games.stats(req.user.id)));
// Global recent-wins feed — anonymised usernames; for social proof.
app.get('/api/feed/global', auth.requireAuth, h(async (req) => ({
  wins: await games.globalFeed(req.query.limit, req.query.min_payout_cents)
})));
app.get('/api/leaderboard', auth.requireAuth, h((req) => games.leaderboard(req.user.id, req.query.metric, req.query.limit)));

// ---------------- Admin (requires is_admin flag) ----------------
const intId = (req, res, next) => {
  if (!/^\d{1,12}$/.test(String(req.params.id))) return res.status(400).json({ error: 'Invalid user id.' });
  next();
};
app.get( '/api/admin/overview', auth.requireAuth, auth.requireAdmin, h(()    => admin.overview()));
app.get( '/api/admin/users',    auth.requireAuth, auth.requireAdmin, h((req) => admin.listUsers(req.query)));
app.get( '/api/admin/user/:id', auth.requireAuth, auth.requireAdmin, intId, h((req) => admin.userDetail(req.params.id)));
app.post('/api/admin/user/:id/balance', auth.requireAuth, auth.requireAdmin, intId, h((req) => admin.adjustBalance(req, req.params.id, req.body || {})));
app.post('/api/admin/user/:id/lock',    auth.requireAuth, auth.requireAdmin, intId, h((req) => admin.setLock(req,    req.params.id, req.body || {})));
app.post('/api/admin/user/:id/admin',   auth.requireAuth, auth.requireAdmin, intId, h((req) => admin.setAdmin(req,   req.params.id, req.body || {})));
app.get( '/api/admin/bets',     auth.requireAuth, auth.requireAdmin, h((req) => admin.recentBets(req.query)));
app.get( '/api/admin/audit',    auth.requireAuth, auth.requireAdmin, h((req) => admin.recentAudit(req.query)));
app.get( '/api/admin/withdrawals', auth.requireAuth, auth.requireAdmin, h((req) => vault.adminListWithdrawals(req.query)));
app.post('/api/admin/withdrawal/:id', auth.requireAuth, auth.requireAdmin, intId, h((req) =>
  vault.adminSettleWithdrawal(req, { withdrawalId: req.params.id, action: (req.body || {}).action, txid: (req.body || {}).txid })));

// Unmatched API routes return JSON, not the SPA shell.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// ---------------- Static frontend ----------------
const PUBLIC = path.join(__dirname, '..', 'public');
// Browsers cache versioned-ish assets aggressively (1 day); index.html stays
// fresh-revalidated so the rest of the SPA picks up new builds quickly.
app.use(express.static(PUBLIC, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-cache');
    } else if (/\.(svg|png|jpg|jpeg|webp|ico|woff2?|ttf)$/.test(filePath)) {
      res.set('Cache-Control', 'public, max-age=86400');
    } else if (/\.(css|js)$/.test(filePath)) {
      res.set('Cache-Control', 'public, max-age=600, must-revalidate');
    }
  }
}));
app.get('*', (req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(PUBLIC, 'index.html')));

db.init()
  .then(async () => {
    // Fail-fast on misconfigured VAULT_PROCESSOR — surfacing at boot is
    // friendlier than 500-ing every /api/vault request.
    vault.validate();
    // If ADMIN_USERNAME is set, promote that user at startup so it sticks
    // across restarts and Postgres → SQLite swaps.
    await auth.ensureAdminUser();
    await games.jackpotEnsure();
    // Race payouts are lazy (first /api/race call settles the last hour) —
    // this timer is the backstop so winners get paid even on a quiet server.
    race.settlePrevious().catch(() => {});
    setInterval(() => race.settlePrevious().catch(() => {}), 60_000).unref();
    const server = app.listen(PORT, () => console.log(`Crypt Casino listening on http://localhost:${PORT}`));
    // Graceful shutdown: let in-flight requests (wager transactions!) finish
    // before the process exits on a deploy or Ctrl+C. Hard-exit after 8s.
    const shutdown = (sig) => {
      console.log(`${sig} — draining connections…`);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 8000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  })
  .catch((e) => {
    console.error('Failed to initialize:', e.message);
    process.exit(1);
  });
