'use strict';

const path = require('path');
const express = require('express');

const db = require('./db');
const auth = require('./auth');
const fair = require('./fair');
const games = require('./games');

const app = express();
const PORT = process.env.PORT || 3000;

// Behind a hosting proxy (Render/Railway/Fly/Heroku/nginx) that terminates TLS.
app.set('trust proxy', 1);

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

// ---------------- History / stats ----------------
app.get('/api/history', auth.requireAuth, h(async (req) => ({ bets: await games.history(req.user.id, req.query.limit) })));
app.get('/api/stats',   auth.requireAuth, h((req) => games.stats(req.user.id)));

// ---------------- Static frontend ----------------
const PUBLIC = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC));
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

db.init()
  .then(() => {
    app.listen(PORT, () => console.log(`NEONSTAKE listening on http://localhost:${PORT}`));
  })
  .catch((e) => {
    console.error('Failed to initialize storage:', e);
    process.exit(1);
  });
