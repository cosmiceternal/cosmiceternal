'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { createServer } = require('../src/server');
const { testApp, cleanup } = require('./helpers');

test.after(cleanup);

async function withServer(overrides, fn) {
  const app = testApp(overrides);
  await app.pipeline.runOnce({ sourceIds: ['sample'] });
  const server = createServer(app);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({ app, base });
  } finally {
    await new Promise((resolve) => { server.close(resolve); });
  }
}

// Sends the path exactly as written, without the URL normalisation fetch()
// applies, so traversal attempts actually reach the server.
function rawStatus(base, rawPath) {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

function get(base, pathname, options = {}) {
  return fetch(`${base}${pathname}`, options);
}

test('health and stats describe the running service', async () => {
  await withServer({}, async ({ base }) => {
    const health = await (await get(base, '/api/health')).json();
    assert.equal(health.ok, true);
    assert.deepEqual(health.sources, ['sample']);

    const stats = await (await get(base, '/api/stats')).json();
    assert.equal(stats.tracked, 23);
    assert.ok(stats.deals > 0);
    assert.ok(stats.potentialProfit > 0);
    assert.ok(stats.lastRun, 'the last run is reported');
  });
});

test('lots can be filtered, sorted, paged and fetched individually', async () => {
  await withServer({}, async ({ base }) => {
    const all = await (await get(base, '/api/lots?limit=500')).json();
    assert.equal(all.total, 23);

    const rich = await (await get(base, '/api/lots?minMargin=50&dealsOnly=1')).json();
    assert.ok(rich.total >= 1);
    assert.ok(rich.lots.every((lot) => lot.deal.marginPct >= 0.5));

    const paged = await (await get(base, '/api/lots?limit=2&offset=1&sort=profit')).json();
    assert.equal(paged.lots.length, 2);
    assert.equal(paged.limit, 2);
    assert.equal(paged.offset, 1);

    const one = await (await get(base, `/api/lots/${encodeURIComponent(all.lots[0].id)}`)).json();
    assert.equal(one.id, all.lots[0].id);
    assert.ok(one.valuation.adjustments.length, 'the detail view can show its working');

    assert.equal((await get(base, '/api/lots/does-not-exist')).status, 404);
  });
});

test('rules can be created, updated and deleted over the API', async () => {
  await withServer({}, async ({ base }) => {
    const created = await (await get(base, '/api/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Servers in Virginia',
        filters: { categories: 'servers', states: 'VA' },
        thresholds: { minMarginPct: 40 },
      }),
    })).json();
    assert.equal(created.name, 'Servers in Virginia');
    assert.deepEqual(created.filters.categories, ['servers']);
    assert.equal(created.thresholds.minMarginPct, 0.4, '40 is read as 40%');

    const updated = await (await get(base, `/api/rules/${created.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })).json();
    assert.equal(updated.enabled, false);
    assert.equal(updated.name, 'Servers in Virginia', 'a partial update keeps the rest');

    assert.equal((await get(base, `/api/rules/${created.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await get(base, `/api/rules/${created.id}`, { method: 'DELETE' })).status, 404);
  });
});

test('an invalid rule is rejected with the reason', async () => {
  await withServer({}, async ({ base }) => {
    const res = await get(base, '/api/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'bad', channels: [{ type: 'slack' }] }),
    });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /needs a url/);
  });
});

test('scrape can be triggered over the API', async () => {
  await withServer({}, async ({ base }) => {
    const summary = await (await get(base, '/api/scrape', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sources: ['sample'], dryRun: true }),
    })).json();
    assert.equal(summary.scraped, 24);
    assert.equal(summary.updated, 23);
  });
});

test('sources report whether their endpoint has been verified', async () => {
  await withServer({}, async ({ base }) => {
    const { sources } = await (await get(base, '/api/sources')).json();
    const sample = sources.find((s) => s.id === 'sample');
    assert.equal(sample.enabled, true);
    assert.equal(sample.offline, true);

    const govdeals = sources.find((s) => s.id === 'govdeals');
    assert.equal(govdeals.enabled, false);
    assert.equal(govdeals.verified, false, 'shipped endpoints are flagged as unverified');
    assert.ok(govdeals.notes.length, 'and say how to repair them');
  });
});

test('an API token locks the whole API down', async () => {
  await withServer({ apiToken: 'sekrit' }, async ({ base }) => {
    assert.equal((await get(base, '/api/stats')).status, 401);
    assert.equal((await get(base, '/api/stats', { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await get(base, '/api/stats', { headers: { authorization: 'Bearer sekrit' } })).status, 200);
    assert.equal((await get(base, '/')).status, 200, 'the dashboard shell still loads so it can ask for the token');
  });
});

test('static files are served and traversal is refused', async () => {
  await withServer({}, async ({ base }) => {
    const index = await get(base, '/');
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type'), /text\/html/);
    assert.match(await index.text(), /dealhunter/);

    assert.equal((await get(base, '/app.js')).status, 200);
    assert.equal((await get(base, '/nope.css')).status, 404);
    assert.equal((await get(base, '/', { method: 'POST' })).status, 405);

    // Traversal has to be driven over a raw request: fetch() normalises the
    // path before it leaves the client. The property that matters is that
    // nothing outside web/ is ever served, whichever encoding is used. Plain
    // and %2e-encoded dot segments are collapsed by the URL parser, so they
    // resolve to a missing file inside web/ (404); %2f survives parsing and is
    // caught by the guard after decoding (403).
    for (const attempt of ['/%2e%2e/package.json', '/../../package.json', '/..%2f..%2fpackage.json',
      '/..%2f..%2fsrc%2fserver.js', '/%2e%2e%2fpackage.json']) {
      const status = await rawStatus(base, attempt);
      assert.ok(status === 403 || status === 404, `${attempt} returned ${status}`);
    }
    assert.equal(await rawStatus(base, '/..%2f..%2fpackage.json'), 403, 'the guard rejects an encoded escape');
    assert.equal(await rawStatus(base, '/%zz'), 400, 'a malformed escape is a bad request');
  });
});

test('malformed and oversized bodies are rejected cleanly', async () => {
  await withServer({}, async ({ base }) => {
    const bad = await get(base, '/api/rules', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
    });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /invalid JSON/);

    const huge = await get(base, '/api/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x'.repeat(400 * 1024) }),
    }).catch(() => ({ status: 413 }));
    assert.equal(huge.status, 413);
  });
});

test('unknown routes 404 rather than hanging', async () => {
  await withServer({}, async ({ base }) => {
    const res = await get(base, '/api/nothing-here');
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /no route/);
  });
});
