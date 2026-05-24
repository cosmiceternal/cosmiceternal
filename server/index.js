'use strict';

const path = require('path');
const express = require('express');

const auth = require('./auth');
const fair = require('./fair');
const games = require('./games');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '32kb' }));
app.use(auth.authenticate);

// Wrap async-ish handlers so thrown httpErrors become JSON responses.
const h = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (out !== undefined) res.json(out);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    res.status(status).json({ error: e.message || 'Server error.' });
  }
};

// ---------------- Auth ----------------
app.post('/api/auth/register', (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = auth.register(username, password);
    auth.setSessionCookie(res, user.id);
    res.json({ user: auth.publicUser(user) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = auth.login(username, password);
    auth.setSessionCookie(res, user.id);
    res.json({ user: auth.publicUser(user) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: auth.publicUser(req.user) });
});

// ---------------- Provably fair ----------------
app.get('/api/fair', auth.requireAuth, h((req) => fair.publicState(req.user.id)));
app.post('/api/fair/client', auth.requireAuth, h((req) => fair.setClientSeed(req.user.id, (req.body || {}).clientSeed)));
app.post('/api/fair/rotate', auth.requireAuth, h((req) => {
  const revealed = fair.rotate(req.user.id);
  return Object.assign({ state: fair.publicState(req.user.id) }, revealed);
}));
app.get('/api/fair/history', auth.requireAuth, h((req) => ({ rolls: games.history(req.user.id, req.query.limit) })));

// ---------------- Games ----------------
app.post('/api/play/dice',   auth.requireAuth, h((req) => games.playDice(req.user.id, req.body || {})));
app.post('/api/play/plinko', auth.requireAuth, h((req) => games.playPlinko(req.user.id, req.body || {})));

app.post('/api/play/crash', auth.requireAuth, h((req) => games.playCrash(req.user.id, req.body || {})));

app.post('/api/play/mines/start',   auth.requireAuth, h((req) => games.minesStart(req.user.id, req.body || {})));
app.post('/api/play/mines/reveal',  auth.requireAuth, h((req) => games.minesReveal(req.user.id, req.body || {})));
app.post('/api/play/mines/cashout', auth.requireAuth, h((req) => games.minesCashout(req.user.id, req.body || {})));

// ---------------- History / stats ----------------
app.get('/api/history', auth.requireAuth, h((req) => ({ bets: games.history(req.user.id, req.query.limit) })));
app.get('/api/stats',   auth.requireAuth, h((req) => games.stats(req.user.id)));

// ---------------- Static frontend ----------------
const PUBLIC = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC));
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

app.listen(PORT, () => {
  console.log(`NEONSTAKE listening on http://localhost:${PORT}`);
});
