'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { loadConfig, costsFor, deepMerge, DEFAULTS } = require('../src/config');
const { tempDir, cleanup } = require('./helpers');

test.after(cleanup);

test('defaults load with no config file and no environment', () => {
  const config = loadConfig({ configFile: null, env: {} });
  assert.equal(config.port, DEFAULTS.port);
  assert.deepEqual(config.sources, ['sample']);
  assert.equal(config.thresholds.minMarginPct, 0.35);
  assert.ok(path.isAbsolute(config.dataDir), 'the data dir is resolved to an absolute path');
});

test('environment variables override defaults, and unset ones do not', () => {
  const config = loadConfig({
    configFile: null,
    env: { PORT: '4000', MIN_PROFIT: '750', SOURCES: 'govdeals, allsurplus', SALES_TAX_PCT: '' },
  });
  assert.equal(config.port, 4000);
  assert.equal(config.thresholds.minProfit, 750);
  assert.deepEqual(config.sources, ['govdeals', 'allsurplus'], 'lists are split and trimmed');
  assert.equal(config.thresholds.minMarginPct, 0.35, 'unmentioned thresholds keep their defaults');
  assert.equal(config.costs.salesTaxPct, 0, 'an empty variable is treated as unset');
});

test('a config file sits between defaults and the environment', () => {
  const dir = tempDir();
  const file = path.join(dir, 'dealhunter.config.json');
  fs.writeFileSync(file, JSON.stringify({
    port: 5000,
    sources: ['govdeals'],
    costs: { buyerPremiumPct: 0.125 },
    thresholds: { minProfit: 300 },
  }));

  const fromFile = loadConfig({ configFile: file, env: {} });
  assert.equal(fromFile.port, 5000);
  assert.equal(fromFile.costs.buyerPremiumPct, 0.125);
  assert.equal(fromFile.costs.marketplaceFeePct, 0.13, 'a partial costs block merges rather than replaces');
  assert.equal(fromFile.thresholds.minProfit, 300);

  const overridden = loadConfig({ configFile: file, env: { PORT: '6000' } });
  assert.equal(overridden.port, 6000, 'the environment wins over the file');
  assert.equal(overridden.costs.buyerPremiumPct, 0.125, 'and leaves the rest of the file alone');
});

test('a broken config file fails loudly', () => {
  const file = path.join(tempDir(), 'bad.json');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => loadConfig({ configFile: file, env: {} }), /not valid JSON/);
});

test('per-category costs layer over the flat cost model', () => {
  const config = loadConfig({ configFile: null, env: {} });
  const servers = costsFor(config, 'servers');
  const laptops = costsFor(config, 'laptops');
  const unknown = costsFor(config, 'misc');

  assert.equal(servers.refurbCostPerUnit, 45);
  assert.equal(servers.marketplaceFeePct, 0.13, 'unspecified keys fall through to the flat model');
  assert.equal(laptops.outboundShipPerUnit, 18);
  assert.equal(unknown.refurbCostPerUnit, DEFAULTS.costs.refurbCostPerUnit);
  assert.equal(unknown.byCategory, undefined, 'the override map is not leaked into the flat model');
});

test('deepMerge merges objects and replaces arrays', () => {
  const merged = deepMerge({ a: { b: 1, c: 2 }, list: [1, 2] }, { a: { c: 3 }, list: [9] });
  assert.deepEqual(merged, { a: { b: 1, c: 3 }, list: [9] });
});
