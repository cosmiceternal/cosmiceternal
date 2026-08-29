'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createPipeline, mergeLot, passesGlobalFilter } = require('../src/pipeline');
const { createScheduler } = require('../src/scheduler');
const { queryLots, summarize } = require('../src/query');
const { saveRule } = require('../src/alerts/rules');
const { recordingServer, jsonResponse, testApp, cleanup } = require('./helpers');

test.after(cleanup);

test('a full run scrapes, values, stores and alerts', async () => {
  const app = testApp();
  const summary = await app.pipeline.runOnce({ sourceIds: ['sample'] });

  assert.equal(summary.scraped, 24);
  assert.equal(summary.filtered, 1, 'the scrap lot is excluded by the default keyword filter');
  assert.equal(summary.added, 23);
  assert.deepEqual(summary.warnings, []);
  assert.ok(summary.deals > 5, `expected a board of deals, got ${summary.deals}`);
  assert.ok(summary.alertsSent > 0, 'the default rule should fire on the first run');

  const stored = app.store.collection('lots').all();
  assert.equal(stored.length, 23);
  for (const lot of stored) {
    assert.ok(lot.valuation, 'every stored lot carries its valuation');
    assert.ok(lot.deal, 'every stored lot carries its economics');
  }
});

test('a second run updates rather than duplicating, and suppresses repeat alerts', async () => {
  const app = testApp();
  await app.pipeline.runOnce({ sourceIds: ['sample'] });
  const second = await app.pipeline.runOnce({ sourceIds: ['sample'] });

  assert.equal(second.added, 0);
  assert.equal(second.updated, 23);
  assert.equal(second.alertsSent, 0, 'nothing material changed inside the cooldown');
  assert.ok(second.alertsSuppressed > 0);
  assert.equal(app.store.collection('lots').count(), 23, 'no duplicate lots');
});

test('price history grows only when the bid actually moves', () => {
  const now = '2026-08-29T00:00:00.000Z';
  const first = { id: 'a', currentBid: 100, bidCount: 1, firstSeenAt: now, lastSeenAt: now, priceHistory: [{ at: now, bid: 100, bidCount: 1 }] };
  const same = mergeLot(first, { ...first, currentBid: 100 }, '2026-08-29T01:00:00.000Z');
  assert.equal(same.priceHistory.length, 1);
  assert.equal(same.firstSeenAt, now, 'first seen is preserved');

  const moved = mergeLot(same, { ...first, currentBid: 150, bidCount: 2 }, '2026-08-29T02:00:00.000Z');
  assert.equal(moved.priceHistory.length, 2);
  assert.equal(moved.priceHistory[1].bid, 150);
});

test('the global keyword filter drops what you never want to see', () => {
  const config = { categories: [], keywords: [], excludeKeywords: ['parts only'] };
  assert.equal(passesGlobalFilter({ title: 'Good laptops', description: '' }, config), true);
  assert.equal(passesGlobalFilter({ title: 'Broken, parts only', description: '' }, config), false);
  assert.equal(passesGlobalFilter({ title: 'Server', description: '' }, { ...config, categories: ['laptops'], }), false);
});

test('an unknown source id is reported instead of silently scraping nothing', async () => {
  const app = testApp();
  const summary = await app.pipeline.runOnce({ sourceIds: ['not-a-source'] });
  assert.equal(summary.scraped, 0);
  assert.match(summary.warnings[0], /unknown source "not-a-source"/);
});

test('one broken source does not stop the others', async () => {
  const app = testApp();
  app.registry.set('broken', {
    id: 'broken',
    label: 'broken',
    async collect() { throw new Error('upstream exploded'); },
  });
  const summary = await app.pipeline.runOnce({ sourceIds: ['broken', 'sample'] });
  assert.ok(summary.warnings.some((w) => /upstream exploded/.test(w)));
  assert.equal(summary.kept, 23, 'the healthy source still delivered');
});

test('a rule with a webhook delivers a real alert end to end', async () => {
  const server = recordingServer((req, res) => jsonResponse(res, { ok: true }));
  const base = await server.listen();
  try {
    const app = testApp();
    app.store.collection('rules').clear();
    saveRule(app.store, {
      id: 'aeron-watch',
      name: 'High margin furniture',
      filters: { categories: ['furniture'] },
      thresholds: { minMarginPct: 30, minProfit: 500 },
      channels: [{ type: 'webhook', url: `${base}/hook` }],
    }, {});

    const summary = await app.pipeline.runOnce({ sourceIds: ['sample'] });
    assert.equal(summary.alertsSent, 1, 'exactly the one furniture lot matched');
    assert.equal(server.requests.length, 1);

    const payload = JSON.parse(server.requests[0].body);
    assert.match(payload.lot.title, /Aeron/);
    assert.equal(payload.rule.id, 'aeron-watch');
    assert.ok(payload.economics.maxBid > payload.lot.currentBid, 'the alert says how much room is left');

    const alerts = app.store.collection('alerts').all();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].deliveries[0].ok, true);
  } finally {
    await server.close();
  }
});

test('dry run values everything but delivers nothing', async () => {
  const server = recordingServer((req, res) => jsonResponse(res, { ok: true }));
  const base = await server.listen();
  try {
    const app = testApp();
    app.store.collection('rules').clear();
    saveRule(app.store, {
      name: 'everything', thresholds: { minProfit: 1 }, channels: [{ type: 'webhook', url: `${base}/hook` }],
    }, {});
    const summary = await app.pipeline.runOnce({ sourceIds: ['sample'], dryRun: true });
    assert.ok(summary.alertsSent > 0);
    assert.equal(server.requests.length, 0, 'dry run must not touch the network');
  } finally {
    await server.close();
  }
});

test('re-valuing applies a comps change without re-scraping', async () => {
  const app = testApp();
  await app.pipeline.runOnce({ sourceIds: ['sample'] });
  const before = app.store.collection('lots').get('govdeals:GD-100902').valuation.unitValue;

  const pipeline = createPipeline({
    config: app.config,
    store: app.store,
    log: app.log,
    http: app.http,
    registry: app.registry,
    comps: { ...app.comps, comps: app.comps.comps.map((c) => (c.id === 'aeron-size-b' ? { ...c, unitValue: 900 } : c)) },
  });
  const count = pipeline.revalueAll();
  assert.equal(count, 23);
  const after = app.store.collection('lots').get('govdeals:GD-100902').valuation.unitValue;
  assert.ok(after > before, `expected the Aeron comp bump to raise the value (${before} -> ${after})`);
});

test('pruning removes lots that closed long ago', async () => {
  const app = testApp();
  await app.pipeline.runOnce({ sourceIds: ['sample'] });
  const future = Date.now() + 60 * 86400000;
  const removed = app.pipeline.prune(future, 14);
  assert.equal(removed, 23);
  assert.equal(app.store.collection('lots').count(), 0);
});

test('query filters and sorting agree with the numbers on the lots', async () => {
  const app = testApp();
  await app.pipeline.runOnce({ sourceIds: ['sample'] });
  const all = app.store.collection('lots').all();

  const deals = queryLots(all, { dealsOnly: '1', limit: 500 });
  assert.ok(deals.lots.every((lot) => lot.deal.score > 0));
  for (let i = 1; i < deals.lots.length; i += 1) {
    assert.ok(deals.lots[i - 1].deal.score >= deals.lots[i].deal.score, 'sorted by score');
  }

  const rich = queryLots(all, { minMargin: 50, limit: 500 });
  assert.ok(rich.lots.every((lot) => lot.deal.marginPct >= 0.5));
  assert.ok(rich.total < deals.total);

  const laptops = queryLots(all, { category: 'laptops', limit: 500 });
  assert.ok(laptops.lots.every((lot) => lot.category === 'laptops'));

  const byProfit = queryLots(all, { sort: 'profit', limit: 5 });
  assert.ok(byProfit.lots[0].deal.profit >= byProfit.lots[4].deal.profit);

  const stats = summarize(all);
  assert.equal(stats.tracked, 23);
  assert.ok(stats.potentialProfit > 0);
  assert.ok(stats.best.title);
});

test('the scheduler runs once on start and never overlaps itself', async () => {
  const app = testApp();
  const scheduler = createScheduler({
    pipeline: app.pipeline,
    config: { ...app.config, scrapeIntervalMs: 3600000, scrapeJitterMs: 0, scrapeOnStart: true },
    log: app.log,
  });
  await scheduler.start();
  const status = scheduler.status();
  assert.equal(status.runCount, 1);
  assert.ok(status.nextRunAt, 'the next run is scheduled');
  assert.equal(status.lastRun.kept, 23);
  scheduler.stop();
  assert.equal(scheduler.status().nextRunAt, null);
});

test('a scheduler tick survives a failing run', async () => {
  const app = testApp();
  const scheduler = createScheduler({
    pipeline: { async runOnce() { throw new Error('scrape blew up'); } },
    config: { ...app.config, scrapeIntervalMs: 3600000, scrapeJitterMs: 0, scrapeOnStart: true },
    log: app.log,
  });
  await scheduler.start();
  assert.match(scheduler.status().lastError.message, /scrape blew up/);
  assert.equal(scheduler.status().runCount, 0);
  scheduler.stop();
});
