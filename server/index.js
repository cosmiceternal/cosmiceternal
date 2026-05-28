'use strict';

const path = require('path');
const express = require('express');

const db = require('./db');
const auth = require('./auth');
const fair = require('./fair');
const games = require('./games');

const app = express();
const PORT = process.env.PORT || 3000;
const SECURE = process.env.SECURE_COOKIES === '1';

// Behind a hosting proxy (Render/Railway/Fly/Heroku/nginx) that terminates TLS.
app.set('trust proxy', 1);
app.disable('x-powered-by');

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
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (SECURE) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
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
app.use('/api', apiLimiter);
app.use(['/api/auth/login', '/api/auth/register'], authLimiter);

app.use(express.json({ limit: '32kb' }));
app.use(auth.authenticate);

// Wrap handlers so thrown/rejected httpErrors become JSON responses.
const h = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) res.status(status).json({ error: e.message || 'Server error.' });
  }
};

// ---------------- Auth ----------------
app.post('/api/auth/register', h(async (req, res) => {
  const { username, password } = req.body || {};
  const user = await auth.register(username, password);
  auth.setSessionCookie(res, user.id);
  res.json({ user: auth.publicUser(user) });
}));

app.post('/api/auth/login', h(async (req, res) => {
  const { username, password } = req.body || {};
  const user = await auth.login(username, password);
  auth.setSessionCookie(res, user.id);
  res.json({ user: auth.publicUser(user) });
}));

app.post('/api/auth/logout', (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.user ? auth.publicUser(req.user) : null });
});

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
app.post('/api/play/slots',  auth.requireAuth, h((req) => games.playSlots(req.user.id, req.body || {})));
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

app.post('/api/play/penalty/start',   auth.requireAuth, h((req) => games.penaltyStart(req.user.id, req.body || {})));
app.post('/api/play/penalty/shoot',   auth.requireAuth, h((req) => games.penaltyShoot(req.user.id, req.body || {})));
app.post('/api/play/penalty/cashout', auth.requireAuth, h((req) => games.penaltyCashout(req.user.id, req.body || {})));

// ---------------- History / stats ----------------
app.get('/api/history', auth.requireAuth, h(async (req) => ({ bets: await games.history(req.user.id, req.query.limit) })));
app.get('/api/stats',   auth.requireAuth, h((req) => games.stats(req.user.id)));

// Unmatched API routes return JSON, not the SPA shell.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// ---------------- Static frontend ----------------
const PUBLIC = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC));
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

db.init()
  .then(() => {
    app.listen(PORT, () => console.log(`Crypt Casino listening on http://localhost:${PORT}`));
  })
  .catch((e) => {
    console.error('Failed to initialize storage:', e);
    process.exit(1);
  });
