'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createHttpClient, parseRobots } = require('../src/sources/http');
const { runRecipe, recordsFromPage, getPath, stripTags, fillFromRecord, validateRecipe } = require('../src/sources/recipe');
const { loadSources, selectSources } = require('../src/sources');
const { recordingServer, jsonResponse, textResponse } = require('./helpers');

const FAST = { requestsPerSecond: 1000, retries: 1, timeoutMs: 2000, respectRobots: false };

test('robots.txt: longest match wins and Allow beats Disallow on a tie', () => {
  const robots = parseRobots([
    'User-agent: *',
    'Disallow: /search',
    'Allow: /search/public',
    'Crawl-delay: 2',
  ].join('\n'), 'dealhunter/1.0');
  assert.equal(robots.allows('/search/assets'), false);
  assert.equal(robots.allows('/search/public/list'), true);
  assert.equal(robots.allows('/asset/123'), true);
  assert.equal(robots.crawlDelay, 2);
});

test('robots.txt: a group naming our agent wins over the wildcard group', () => {
  const robots = parseRobots([
    'User-agent: *', 'Disallow: /',
    '', 'User-agent: dealhunter', 'Disallow: /admin',
  ].join('\n'), 'dealhunter/1.0');
  assert.equal(robots.allows('/search'), true);
  assert.equal(robots.allows('/admin/users'), false);
});

test('robots.txt wildcards and end-anchors are honoured', () => {
  const robots = parseRobots('User-agent: *\nDisallow: /*.json$\nDisallow: /private/', 'x');
  assert.equal(robots.allows('/data/thing.json'), false);
  assert.equal(robots.allows('/data/thing.json.html'), true);
  assert.equal(robots.allows('/private/x'), false);
});

test('the client refuses a path robots.txt disallows', async () => {
  const server = recordingServer((req, res) => {
    if (req.url === '/robots.txt') return textResponse(res, 'User-agent: *\nDisallow: /search', 200, 'text/plain');
    return jsonResponse(res, { ok: true });
  });
  const base = await server.listen();
  try {
    const http = createHttpClient({ ...FAST, respectRobots: true });
    await assert.rejects(() => http.getJson(`${base}/search`), /robots\.txt disallows/);
    assert.deepEqual(await http.getJson(`${base}/allowed`), { ok: true });
  } finally {
    await server.close();
  }
});

test('the client retries 5xx and then succeeds', async () => {
  let calls = 0;
  const server = recordingServer((req, res) => {
    calls += 1;
    if (calls === 1) return jsonResponse(res, { error: 'boom' }, 503);
    return jsonResponse(res, { ok: true, calls });
  });
  const base = await server.listen();
  try {
    const http = createHttpClient({ ...FAST, retries: 2 });
    const body = await http.getJson(`${base}/x`);
    assert.equal(body.ok, true);
    assert.equal(body.calls, 2, 'the first attempt was retried');
  } finally {
    await server.close();
  }
});

test('the client gives up after the retry budget and says so', async () => {
  const server = recordingServer((req, res) => jsonResponse(res, { error: 'nope' }, 500));
  const base = await server.listen();
  try {
    const http = createHttpClient({ ...FAST, retries: 1 });
    await assert.rejects(() => http.getJson(`${base}/x`), /failed after 2 attempts/);
  } finally {
    await server.close();
  }
});

test('a JSON recipe maps a search response onto lot records', async () => {
  const server = recordingServer((req, res) => jsonResponse(res, {
    results: [
      {
        id: 991, title: 'Lot of 10 Dell Latitude 5490', currentBid: '$1,200.00',
        bidCount: 3, quantity: 10, auctionCloseDate: '2026-09-01T12:00:00Z',
        location: 'Austin, TX', sellerName: 'City of Austin',
      },
    ],
  }));
  const base = await server.listen();
  try {
    const http = createHttpClient(FAST);
    const result = await runRecipe({
      id: 'test-json',
      kind: 'json',
      url: `${base}/api/search?page={page}&q={query}`,
      itemsPath: 'results',
      map: {
        externalId: 'id',
        title: { path: 'title', transform: 'text' },
        url: { template: 'https://example.test/asset/{id}' },
        currentBid: { path: 'currentBid', transform: 'money' },
        bidCount: { path: 'bidCount', transform: 'int' },
        closesAt: { path: 'auctionCloseDate', transform: 'date' },
        location: 'location',
      },
    }, { http, maxPages: 1, vars: { query: 'dell laptop' } });

    assert.equal(result.warnings.length, 0);
    assert.equal(result.records.length, 1);
    const record = result.records[0];
    assert.equal(record.externalId, 991);
    assert.equal(record.currentBid, 1200);
    assert.equal(record.url, 'https://example.test/asset/991');
    assert.equal(record.closesAt, '2026-09-01T12:00:00.000Z');
    assert.match(server.requests[0].url, /q=dell%20laptop/);
  } finally {
    await server.close();
  }
});

test('an HTML recipe reads the embedded state blob', () => {
  const html = `<html><head><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { searchResults: { assets: [{ id: 5, title: 'Cisco 2960X switch', currentBid: 210 }] } } },
  })}</script></head><body></body></html>`;
  const records = recordsFromPage({
    id: 'test-html',
    kind: 'html',
    embeddedJson: { pattern: '<script[^>]+id="__NEXT_DATA__"[^>]*>([\\s\\S]*?)</script>' },
    itemsPath: 'props.pageProps.searchResults.assets',
    map: { externalId: 'id', title: 'title', currentBid: { path: 'currentBid', transform: 'money' } },
  }, html, { recipeId: 'test-html' });
  assert.equal(records.length, 1);
  assert.equal(records[0].title, 'Cisco 2960X switch');
});

test('an HTML recipe falls back to row regexes when the blob is gone', () => {
  const html = `
    <div class="asset-card" data-asset-id="77"><h2>Lot of 5 HP EliteBook 840 G6</h2><p>Current bid $320.00</p></div>
    <div class="asset-card" data-asset-id="78"><h2>Dell PowerEdge R640</h2><p>Current bid $210.00</p></div>`;
  const records = recordsFromPage({
    id: 'test-html',
    kind: 'html',
    embeddedJson: { pattern: 'this-blob-is-not-here-([\\s\\S]*?)-end' },
    rowPattern: '<div[^>]+class="asset-card"[\\s\\S]*?</div>',
    map: {
      externalId: ['id', { regex: 'data-asset-id="([^"]+)"' }],
      title: [{ path: 'title' }, { regex: '<h2[^>]*>([\\s\\S]*?)</h2>', transform: 'text' }],
      currentBid: [{ path: 'currentBid' }, { regex: 'current bid[^$]*\\$([0-9,.]+)', transform: 'money' }],
    },
  }, html, { recipeId: 'test-html' });

  assert.equal(records.length, 2);
  assert.equal(records[0].externalId, '77');
  assert.equal(records[0].title, 'Lot of 5 HP EliteBook 840 G6');
  assert.equal(records[0].currentBid, 320);
});

test('a template that cannot be filled falls through to the next candidate', () => {
  assert.equal(fillFromRecord('https://x/asset/{id}', { id: 7 }), 'https://x/asset/7');
  assert.equal(fillFromRecord('https://x/asset/{id}', {}), undefined);
});

test('pagination stops as soon as a page adds nothing new', async () => {
  let pages = 0;
  const server = recordingServer((req, res) => {
    pages += 1;
    // Every page returns the same record, so page 2 adds nothing.
    jsonResponse(res, { results: [{ id: 1, title: 'Same lot every time' }] });
  });
  const base = await server.listen();
  try {
    const http = createHttpClient(FAST);
    const result = await runRecipe({
      id: 'test-pages', kind: 'json', url: `${base}/s?page={page}`, itemsPath: 'results',
      map: { externalId: 'id', title: 'title' },
    }, { http, maxPages: 5 });
    assert.equal(result.records.length, 1);
    assert.equal(pages, 2, 'stopped after the first duplicate page');
  } finally {
    await server.close();
  }
});

test('a source failure becomes a warning, not an exception', async () => {
  const server = recordingServer((req, res) => textResponse(res, 'not json at all', 200, 'application/json'));
  const base = await server.listen();
  try {
    const http = createHttpClient(FAST);
    const result = await runRecipe({
      id: 'broken', kind: 'json', url: `${base}/s`, itemsPath: 'results',
      map: { externalId: 'id', title: 'title' },
    }, { http, maxPages: 1 });
    assert.equal(result.records.length, 0);
    assert.match(result.warnings[0], /expected JSON/);
  } finally {
    await server.close();
  }
});

test('recipes are validated before they run', () => {
  assert.throws(() => validateRecipe({ id: 'x', kind: 'json', url: 'https://x', map: {} }), /must include externalId/);
  assert.throws(() => validateRecipe({ id: 'x', kind: 'xml', url: 'https://x', map: { externalId: 'a', title: 'b' } }), /kind must be/);
  assert.throws(() => validateRecipe({ id: 'x', kind: 'html', url: 'https://x', map: { externalId: 'a', title: 'b' } }), /rowPattern or embeddedJson/);
});

test('every shipped recipe is valid and the registry resolves it', () => {
  const { registry, problems } = loadSources();
  assert.deepEqual(problems, [], 'no shipped recipe should fail validation');
  for (const id of ['sample', 'govdeals', 'govdeals-html', 'allsurplus', 'itad-hibid', 'itad-generic']) {
    assert.ok(registry.has(id), `expected a source called ${id}`);
  }
  const { selected, unknown } = selectSources(registry, ['govdeals', 'does-not-exist']);
  assert.equal(selected.length, 1);
  assert.deepEqual(unknown, ['does-not-exist']);
});

test('helpers: dot paths and tag stripping', () => {
  assert.equal(getPath({ a: { b: [{ c: 9 }] } }, 'a.b.0.c'), 9);
  assert.equal(getPath({ a: 1 }, 'a.b.c'), undefined);
  assert.equal(stripTags('<h2>Lot of 25 &amp; more</h2>'), 'Lot of 25 & more');
  assert.equal(stripTags('<script>bad()</script>clean'), 'clean');
});
