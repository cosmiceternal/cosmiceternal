'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { normalizeRule } = require('../src/alerts/rules');
const { matchRule, shouldNotify, recordNotification } = require('../src/alerts/match');
const { dispatch, slackPayload, discordPayload, webhookPayload, plainText } = require('../src/alerts/notify');
const { recordingServer, jsonResponse, tempDir, cleanup } = require('./helpers');

test.after(cleanup);

function entry(overrides = {}) {
  return {
    lot: {
      id: 'govdeals:1', source: 'govdeals', externalId: '1', title: 'Lot of 25 Dell Latitude 5490 Laptops',
      description: '', category: 'laptops', condition: 'used', quantity: 25, currentBid: 450,
      bidCount: 3, currency: 'USD', closesAt: new Date(Date.now() + 36e5 * 20).toISOString(),
      location: { city: 'Austin', state: 'TX', country: 'US' }, url: 'https://example.test/1',
      ...(overrides.lot || {}),
    },
    valuation: { totalValue: 2500, unitValue: 100, confidence: 0.7, method: 'comp', compLabel: 'Dell Latitude 5490', notes: [], ...(overrides.valuation || {}) },
    deal: {
      profit: 800, marginPct: 0.42, roi: 0.65, score: 61, maxBid: 900, breakEvenBid: 1200,
      hoursToClose: 20, closed: false, landed: { total: 1230 }, targetMarginPct: 0.35,
      ...(overrides.deal || {}),
    },
  };
}

test('percentages are accepted as 40 or 0.4', () => {
  const rule = normalizeRule({ name: 'r', thresholds: { minMarginPct: 40, minRoi: 0.5, minConfidence: 60 } });
  assert.equal(rule.thresholds.minMarginPct, 0.4);
  assert.equal(rule.thresholds.minRoi, 0.5);
  assert.equal(rule.thresholds.minConfidence, 0.6);
});

test('rules are validated on the way in', () => {
  assert.throws(() => normalizeRule({ name: '' }), /needs a name/);
  assert.throws(() => normalizeRule({ name: 'r', channels: [{ type: 'carrier-pigeon' }] }), /unknown channel type/);
  assert.throws(() => normalizeRule({ name: 'r', channels: [{ type: 'slack' }] }), /needs a url/);
  assert.throws(() => normalizeRule({ name: 'r', channels: [{ type: 'slack', url: 'ftp://x/y' }] }), /must be http/);
});

test('a rule matches when every filter and threshold passes', () => {
  const rule = normalizeRule({
    name: 'laptops in texas',
    filters: { categories: ['laptops'], states: ['TX', 'OK'], keywords: ['latitude'] },
    thresholds: { minMarginPct: 35, minProfit: 500 },
  });
  const result = matchRule(rule, entry());
  assert.deepEqual(result.failures, []);
  assert.equal(result.matched, true);
});

test('a failing rule explains exactly what failed', () => {
  const rule = normalizeRule({
    name: 'strict',
    filters: { categories: ['servers'], states: ['CA'] },
    thresholds: { minProfit: 5000, minConfidence: 0.95 },
  });
  const result = matchRule(rule, entry());
  assert.equal(result.matched, false);
  assert.ok(result.failures.some((f) => /category laptops/.test(f)));
  assert.ok(result.failures.some((f) => /location TX/.test(f)));
  assert.ok(result.failures.some((f) => /profit 800 below 5000/.test(f)));
  assert.ok(result.failures.some((f) => /confidence 0\.7 below 0\.95/.test(f)));
});

test('excluded keywords and closed auctions block a match', () => {
  const rule = normalizeRule({ name: 'r', filters: { excludeKeywords: ['latitude'] } });
  assert.equal(matchRule(rule, entry()).matched, false);

  const open = normalizeRule({ name: 'r' });
  assert.equal(matchRule(open, entry({ deal: { closed: true } })).matched, false);
});

test('the same lot is not re-alerted inside the cooldown', () => {
  const rule = normalizeRule({ name: 'r', cooldownMinutes: 60 });
  const now = Date.now();
  assert.deepEqual(shouldNotify(rule, entry(), null, now), { send: true, reason: 'new' });

  const state = recordNotification(null, rule, entry(), { reason: 'new' }, now);
  const soon = shouldNotify(rule, entry(), state, now + 10 * 60000);
  assert.equal(soon.send, false);
  assert.match(soon.reason, /cooldown/);
});

test('a material bid move re-alerts once the cooldown has passed', () => {
  const rule = normalizeRule({ name: 'r', cooldownMinutes: 60, rebidPct: 0.15 });
  const now = Date.now();
  const state = recordNotification(null, rule, entry(), { reason: 'new' }, now);
  const later = now + 120 * 60000;

  const small = shouldNotify(rule, entry({ lot: { currentBid: 470 } }), state, later);
  assert.equal(small.send, false, '4% is not a material move');

  const big = shouldNotify(rule, entry({ lot: { currentBid: 600 } }), state, later);
  assert.equal(big.send, true);
  assert.match(big.reason, /bid moved/);
});

test('a still-good lot gets one last-call alert as it closes', () => {
  const rule = normalizeRule({ name: 'r', cooldownMinutes: 60 });
  const now = Date.now();
  const first = recordNotification(null, rule, entry(), { reason: 'new' }, now);
  const later = now + 120 * 60000;
  const closing = entry({ deal: { hoursToClose: 1.5 } });

  const decision = shouldNotify(rule, closing, first, later);
  assert.equal(decision.send, true);
  assert.match(decision.reason, /closing within 2 hours/);

  const after = recordNotification(first, rule, closing, decision, later);
  assert.equal(shouldNotify(rule, closing, after, later + 120 * 60000).send, false, 'only one last call');
});

test('payload shapes carry the numbers a human needs to act', () => {
  const rule = normalizeRule({ name: 'my rule' });
  const e = entry();
  const slack = slackPayload(e, rule);
  assert.match(slack.text, /\$800 profit/);
  assert.ok(slack.blocks.length >= 2);

  const discord = discordPayload(e, rule);
  assert.equal(discord.embeds[0].url, 'https://example.test/1');
  assert.ok(discord.embeds[0].fields.some((f) => f.name === 'Max bid' && f.value === '$900'));

  const hook = webhookPayload(e, rule, 'new');
  assert.equal(hook.lot.id, 'govdeals:1');
  assert.equal(hook.economics.maxBid, 900);
  assert.equal(hook.reason, 'new');

  assert.match(plainText(e, rule), /max bid \$900/);
});

test('webhook, slack and discord channels post real payloads', async () => {
  const server = recordingServer((req, res) => jsonResponse(res, { ok: true }));
  const base = await server.listen();
  const dir = tempDir();
  try {
    const rule = normalizeRule({
      name: 'everything',
      channels: [
        { type: 'console' },
        { type: 'webhook', url: `${base}/hook` },
        { type: 'slack', url: `${base}/slack` },
        { type: 'discord', url: `${base}/discord` },
        { type: 'file', path: 'alerts.ndjson' },
      ],
    });
    const results = await dispatch(rule, entry(), 'new', { dataDir: dir, timeoutMs: 3000 });
    assert.equal(results.length, 5);
    assert.ok(results.every((r) => r.ok), JSON.stringify(results));
    assert.equal(server.requests.length, 3);

    const posted = JSON.parse(server.requests.find((r) => r.url === '/hook').body);
    assert.equal(posted.lot.title, 'Lot of 25 Dell Latitude 5490 Laptops');

    const written = fs.readFileSync(path.join(dir, 'alerts.ndjson'), 'utf8').trim().split('\n');
    assert.equal(written.length, 1);
    assert.equal(JSON.parse(written[0]).lot.id, 'govdeals:1');
  } finally {
    await server.close();
  }
});

test('a failing channel is reported, not thrown, and the others still go out', async () => {
  const server = recordingServer((req, res) => {
    if (req.url === '/bad') return jsonResponse(res, { error: 'nope' }, 500);
    return jsonResponse(res, { ok: true });
  });
  const base = await server.listen();
  try {
    const rule = normalizeRule({
      name: 'mixed',
      channels: [{ type: 'webhook', url: `${base}/bad` }, { type: 'webhook', url: `${base}/good` }],
    });
    const results = await dispatch(rule, entry(), 'new', { timeoutMs: 3000 });
    assert.equal(results[0].ok, false);
    assert.equal(results[0].status, 500);
    assert.equal(results[1].ok, true);
  } finally {
    await server.close();
  }
});

test('an unreachable channel fails softly', async () => {
  const rule = normalizeRule({ name: 'dead', channels: [{ type: 'webhook', url: 'http://127.0.0.1:1/nope' }] });
  const results = await dispatch(rule, entry(), 'new', { timeoutMs: 1000 });
  assert.equal(results[0].ok, false);
  assert.ok(results[0].error);
});
