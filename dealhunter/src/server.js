'use strict';

// The HTTP surface: a small JSON API plus the static dashboard. Built on
// node:http because the whole service is meant to run with zero dependencies
// on whatever box you already have.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { queryLots, summarize } = require('./query');
const { listRules, saveRule, deleteRule } = require('./alerts/rules');
const { listCategories } = require('./taxonomy');

const WEB_DIR = path.join(__dirname, '..', 'web');
const MAX_BODY_BYTES = 256 * 1024;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(Object.assign(new Error(`invalid JSON body: ${err.message}`), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// Constant-time compare so a wrong token cannot be recovered by timing the
// response. The tool is meant to sit on a home server or a small VPS, and the
// token is the only thing between the internet and your alert rules.
function tokenMatches(expected, provided) {
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function serveStatic(req, res, urlPath) {
  // URL.pathname leaves percent-escapes intact, so decode before resolving:
  // otherwise "%2e%2e" is treated as a literal filename rather than "..", and
  // a legitimately escaped filename never resolves either.
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    sendJson(res, 400, { error: 'malformed path' });
    return;
  }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const target = path.resolve(WEB_DIR, relative);
  // Path traversal guard: anything resolving outside web/ is not ours to serve.
  if (target !== WEB_DIR && !target.startsWith(WEB_DIR + path.sep)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

function createServer(app) {
  const { config, store, log, pipeline, registry } = app;

  async function handleApi(req, res, url) {
    const segments = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
    const [resource, id] = segments;
    const params = Object.fromEntries(url.searchParams.entries());
    const method = req.method.toUpperCase();

    if (resource === 'health') {
      return sendJson(res, 200, {
        ok: true,
        version: require('../package.json').version,
        sources: config.sources,
        dataDir: config.dataDir,
        scheduler: app.scheduler ? app.scheduler.status() : null,
      });
    }

    if (resource === 'stats' && method === 'GET') {
      const summary = summarize(store.collection('lots').all());
      const runs = store.collection('runs').all()
        .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)).slice(0, 1);
      return sendJson(res, 200, {
        ...summary,
        rules: store.collection('rules').count(),
        alerts: store.collection('alerts').count(),
        lastRun: runs[0] || null,
        scheduler: app.scheduler ? app.scheduler.status() : null,
      });
    }

    if (resource === 'lots' && method === 'GET') {
      if (id) {
        const lot = store.collection('lots').get(decodeURIComponent(id));
        if (!lot) return sendJson(res, 404, { error: 'no such lot' });
        return sendJson(res, 200, lot);
      }
      return sendJson(res, 200, queryLots(store.collection('lots').all(), params));
    }

    if (resource === 'categories' && method === 'GET') {
      return sendJson(res, 200, { categories: listCategories() });
    }

    if (resource === 'sources' && method === 'GET') {
      const sources = Array.from(registry.values()).map((source) => ({
        id: source.id,
        label: source.label,
        kind: source.kind,
        site: source.site || null,
        offline: Boolean(source.offline),
        verified: Boolean(source.verified),
        enabled: config.sources.includes(source.id),
        notes: source.notes || [],
      }));
      return sendJson(res, 200, { sources });
    }

    if (resource === 'alerts' && method === 'GET') {
      const limit = Math.min(Number(params.limit) || 50, 500);
      const alerts = store.collection('alerts').all()
        .sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt)).slice(0, limit);
      return sendJson(res, 200, { alerts, total: store.collection('alerts').count() });
    }

    if (resource === 'runs' && method === 'GET') {
      const limit = Math.min(Number(params.limit) || 20, 200);
      const runs = store.collection('runs').all()
        .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)).slice(0, limit);
      return sendJson(res, 200, { runs });
    }

    if (resource === 'rules') {
      if (method === 'GET') return sendJson(res, 200, { rules: listRules(store) });
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        const body = await readBody(req);
        if (id) body.id = decodeURIComponent(id);
        if ((method === 'PUT' || method === 'PATCH') && body.id) {
          const existing = store.collection('rules').get(body.id);
          if (!existing) return sendJson(res, 404, { error: 'no such rule' });
          Object.assign(existing, body);
          return sendJson(res, 200, saveRule(store, existing, {
            cooldownMinutes: config.alertCooldownMinutes, rebidPct: config.alertRebidPct,
          }));
        }
        return sendJson(res, 201, saveRule(store, body, {
          thresholds: config.thresholds,
          cooldownMinutes: config.alertCooldownMinutes,
          rebidPct: config.alertRebidPct,
        }));
      }
      if (method === 'DELETE' && id) {
        const removed = deleteRule(store, decodeURIComponent(id));
        return sendJson(res, removed ? 200 : 404, removed ? { deleted: id } : { error: 'no such rule' });
      }
    }

    if (resource === 'scrape' && method === 'POST') {
      const body = await readBody(req);
      const summary = await pipeline.runOnce({
        sourceIds: body.sources,
        query: body.query,
        dryRun: Boolean(body.dryRun),
      });
      return sendJson(res, 200, summary);
    }

    if (resource === 'revalue' && method === 'POST') {
      app.reloadComps();
      const count = app.pipeline.revalueAll();
      return sendJson(res, 200, { revalued: count });
    }

    return sendJson(res, 404, { error: `no route for ${method} ${url.pathname}` });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');

    if (!isApi) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      return serveStatic(req, res, url.pathname);
    }

    if (config.apiToken) {
      const header = req.headers.authorization || '';
      const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!tokenMatches(config.apiToken, provided)) {
        return sendJson(res, 401, { error: 'unauthorized' });
      }
    }

    handleApi(req, res, url).catch((err) => {
      log.error('request failed', { path: url.pathname, error: err.message });
      if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message });
    });
  });

  return server;
}

async function startServer(app) {
  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(app.config.port, app.config.host, resolve);
  });
  const address = server.address();
  app.log.info('dashboard listening', {
    url: `http://${app.config.host === '0.0.0.0' ? 'localhost' : app.config.host}:${address.port}`,
    protected: Boolean(app.config.apiToken),
  });
  return server;
}

module.exports = { createServer, startServer, WEB_DIR };
