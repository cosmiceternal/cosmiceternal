'use strict';

/* Standalone, private tax-code reader.
 *
 * Deliberately separate from the casino app: its own process, its own port,
 * bound to localhost by default, and every /api route gated by a bearer token.
 * Set TAX_ACCESS_TOKEN to a fixed secret; if you don't, one is generated and
 * printed at boot so the service is never accidentally left open. */

const path = require('path');
const crypto = require('crypto');
const express = require('express');

const cfg = require('./lib/config');
const sources = require('./lib/sources');
const ai = require('./lib/ai');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// Minimal hardening — this is a private tool, but cheap headers don't hurt.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// ---- Auth: constant-time bearer-token check on everything under /api ----
function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
function requireToken(req, res, next) {
  const header = req.headers['authorization'] || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const token = bearer || req.headers['x-tax-token'];
  if (!token || !timingSafeEqual(token, cfg.accessToken())) {
    return res.status(401).json({ error: 'Unauthorized. Provide the access token as "Authorization: Bearer <token>".' });
  }
  next();
}

// Wrap async handlers → JSON errors with the right status.
const h = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[tax]', e);
    if (!res.headersSent) res.status(status).json({ error: e.message || 'Server error.' });
  }
};

// Health check is open (no token) so uptime monitors can hit it.
app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.use('/api', requireToken);

// What the UI needs to know once authenticated.
app.get('/api/config', (req, res) => res.json({
  aiEnabled: cfg.ai.enabled,
  model: cfg.ai.model,
  sources: ['26 U.S.C. (statute)', '26 C.F.R. (regulations)', 'IRS guidance (Federal Register)', 'Federal tax case law']
}));

// Verbatim section lookup. Accepts ?cite= (GET) or { citation } (POST).
app.get('/api/section', h(async (req) => sources.getSection(req.query.cite)));
app.post('/api/section', h(async (req) => sources.getSection((req.body || {}).citation)));

// Full-text search across statute, regulations, IRS guidance, and case law.
app.post('/api/search', h(async (req) => {
  const { query, scope, limit } = req.body || {};
  return sources.search(query, { scope, limit: Math.min(Number(limit) || 20, 50) });
}));

// Full text of an IRS guidance doc (Federal Register document number).
app.get('/api/guidance', h(async (req) => sources.getDocument({ type: 'guidance', ref: req.query.doc })));

// Full text of a case-law opinion (CourtListener opinion id).
app.get('/api/case', h(async (req) => sources.getDocument({ type: 'caselaw', ref: req.query.id })));

// AI answer grounded in retrieved sections.
app.post('/api/ask', h(async (req) => {
  const { question, cite, scope } = req.body || {};
  return ai.answer({ question, cite, scope });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Static private UI.
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

if (require.main === module) {
  app.listen(cfg.port, cfg.host, () => {
    console.log(`\nTax-code reader (private) listening on http://${cfg.host}:${cfg.port}`);
    if (cfg.tokenWasGenerated()) {
      console.log('\n  No TAX_ACCESS_TOKEN set — generated one for this run:');
      console.log(`    ${cfg.accessToken()}`);
      console.log('  Paste it into the web UI, or send it as "Authorization: Bearer <token>".');
      console.log('  Set TAX_ACCESS_TOKEN in the environment to make it stable.\n');
    }
    if (!cfg.ai.enabled) {
      console.log('  ANTHROPIC_API_KEY not set — lookup & search work; /api/ask (AI answers) are disabled.\n');
    }
  });
}

module.exports = app;
