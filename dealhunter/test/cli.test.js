'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { tempDir, cleanup } = require('./helpers');

test.after(cleanup);

const BIN = path.join(__dirname, '..', 'bin', 'dealhunter.js');

function run(args, env = {}) {
  return execFileSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LOG_LEVEL: 'silent', ...env },
  });
}

test('the CLI runs a demo, lists the board and explains one lot', () => {
  const dataDir = tempDir();
  const env = { DEALHUNTER_DATA_DIR: dataDir, DEALHUNTER_CONFIG: path.join(dataDir, 'none.json') };

  const demo = run(['demo'], env);
  assert.match(demo, /Scraped 24 listings/);
  assert.match(demo, /profitable/);
  assert.match(demo, /Aeron/, 'the board prints the top deal');

  const board = run(['lots', '--min-margin', '50', '--json'], env);
  const parsed = JSON.parse(board);
  assert.ok(parsed.lots.length > 0);
  assert.ok(parsed.lots.every((lot) => lot.deal.marginPct >= 0.5));

  const detail = run(['lot', 'govdeals:GD-100902'], env);
  assert.match(detail, /Herman Miller Aeron/);
  assert.match(detail, /Cost to own/);
  assert.match(detail, /Break-even bid/);
  assert.match(detail, /Bulk discount on 30 units/, 'the breakdown shows its working');
});

test('the CLI manages rules and reports sources', () => {
  const dataDir = tempDir();
  const env = { DEALHUNTER_DATA_DIR: dataDir, DEALHUNTER_CONFIG: path.join(dataDir, 'none.json') };

  run(['rules', 'add', '--name', 'Test rule', '--category', 'laptops', '--min-margin', '45'], env);
  const rules = JSON.parse(run(['rules', 'list', '--json'], env));
  const added = rules.find((rule) => rule.name === 'Test rule');
  assert.ok(added, 'the rule was created');
  assert.deepEqual(added.filters.categories, ['laptops']);
  assert.equal(added.thresholds.minMarginPct, 0.45);

  run(['rules', 'disable', added.id], env);
  assert.equal(JSON.parse(run(['rules', 'list', '--json'], env)).find((r) => r.id === added.id).enabled, false);

  run(['rules', 'rm', added.id], env);
  assert.equal(JSON.parse(run(['rules', 'list', '--json'], env)).find((r) => r.id === added.id), undefined);

  const sources = JSON.parse(run(['sources', '--json'], env));
  assert.ok(sources.find((s) => s.id === 'govdeals'));
  assert.equal(sources.find((s) => s.id === 'sample').enabled, true);
});

test('comps import merges and re-prices in one step', () => {
  const dataDir = tempDir();
  const env = { DEALHUNTER_DATA_DIR: dataDir, DEALHUNTER_CONFIG: path.join(dataDir, 'none.json') };
  run(['demo'], env);
  const before = JSON.parse(run(['lot', 'govdeals:GD-100902', '--json'], env)).valuation.unitValue;

  const csv = path.join(dataDir, 'mycomps.csv');
  require('node:fs').writeFileSync(csv, [
    'id,category,label,terms,unitValue,confidence',
    'aeron-size-b,furniture,"Aeron size B, my sold price",aeron,900,0.95',
  ].join('\n'));

  const output = run(['comps', 'import', csv], env);
  assert.match(output, /Imported 1 comps/);
  assert.match(output, /re-priced 23 lots/);

  const after = JSON.parse(run(['lot', 'govdeals:GD-100902', '--json'], env));
  assert.ok(after.valuation.unitValue > before, 'the imported comp took effect');
  // The comp is stated at 0.95, but a 30-unit lot erodes confidence, so the
  // reported figure sits just under it rather than exactly on it.
  assert.ok(after.valuation.confidence > 0.85 && after.valuation.confidence < 0.95,
    `expected eroded confidence near 0.95, got ${after.valuation.confidence}`);
});

test('help is printed for no command and for an unknown one', () => {
  assert.match(run(['help']), /Usage: dealhunter/);
  assert.throws(
    () => run(['not-a-command']),
    (err) => /unknown command/.test(err.stderr) && err.status === 1,
  );
});
