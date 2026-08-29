'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { loadComps, findComp, hasTerm, parseCompsCsv, mergeTables } = require('../src/valuation/comps');
const { estimateValue, bulkMultiplier, applyPenalties } = require('../src/valuation/estimate');
const { normalizeLot } = require('../src/normalize');

const table = loadComps();

function lotFrom(title, extra = {}) {
  return normalizeLot({ externalId: 'x1', title, ...extra }, { sourceId: 'test' });
}

test('model-number terms tolerate suffixes but not extra digits', () => {
  assert.ok(hasTerm('dell ultrasharp u2419h monitor', 'u2419'), 'U2419H is a U2419');
  assert.ok(hasTerm('john deere 310sl backhoe', '310'), '310SL is a 310');
  assert.equal(hasTerm('part number 154900', '5490'), false, 'not a substring match');
  assert.equal(hasTerm('deere 3100 loader', '310'), false, '3100 is a different model');
});

test('word terms match whole tokens and plurals only', () => {
  assert.ok(hasTerm('lot of 80 chromebooks', 'chromebook'), 'plural still matches');
  assert.equal(hasTerm('airport shuttle bus', 'air'), false, 'no matching inside a longer word');
});

test('comps resolve to the most specific match', () => {
  assert.equal(findComp(table, lotFrom('Lot of 25 Dell Latitude 5490 Laptops')).comp.id, 'dell-latitude-5490');
  assert.equal(findComp(table, lotFrom('(2) HPE ProLiant DL380 Gen10 Servers')).comp.id, 'hpe-dl380-gen10');
  assert.equal(findComp(table, lotFrom('An entirely unremarkable pallet')), null);
});

test('bulk discount only ever reduces, and is floored', () => {
  assert.equal(bulkMultiplier({ slope: 0.08, floor: 0.6 }, 1), 1);
  assert.ok(bulkMultiplier({ slope: 0.08, floor: 0.6 }, 100) < 1);
  assert.ok(bulkMultiplier({ slope: 0.08, floor: 0.6 }, 100000) >= 0.6);
});

test('penalties fire on their pattern and can require a second signal', () => {
  const penalties = [
    { id: 'meraki-unlicensed', pattern: 'meraki', requires: 'unlicensed', multiplier: 0.3, note: 'no licence' },
  ];
  assert.equal(applyPenalties(penalties, 'Meraki MS225 switch, unlicensed').applied.length, 1);
  assert.equal(applyPenalties(penalties, 'Meraki MS225 switch with licence').applied.length, 0);
});

test('a specific penalty supersedes the general one it already covers', () => {
  const penalties = [
    { id: 'specific', pattern: 'meraki', requires: 'unlicensed', multiplier: 0.3, supersedes: ['general'], note: 'a' },
    { id: 'general', pattern: 'unlicensed', multiplier: 0.75, note: 'b' },
  ];
  const result = applyPenalties(penalties, 'Meraki, unlicensed');
  assert.deepEqual(result.applied.map((p) => p.id), ['specific']);
  assert.equal(result.multiplier, 0.3, 'the general deduction is not applied twice');
});

test('an iCloud-locked phone lot is valued near parts money', () => {
  const lot = lotFrom('Lot of 200 Apple iPhone 11 64GB, iCloud Locked, sold for parts only');
  const value = estimateValue(lot, table);
  assert.ok(value.unitValue < 20, `expected parts money, got ${value.unitValue}`);
  assert.ok(value.notes.some((note) => /activation lock/i.test(note)));
});

test('condition moves the comp off its quoted basis', () => {
  const used = estimateValue(lotFrom('Dell Latitude 5490 laptop, tested working'), table);
  const salvage = estimateValue(lotFrom('Dell Latitude 5490 laptop, for parts only'), table);
  assert.ok(salvage.unitValue < used.unitValue / 3);
});

test('spec adjustments use numeric thresholds', () => {
  const base = estimateValue(lotFrom('Dell Latitude 5490 laptop, tested working'), table);
  const loaded = estimateValue(lotFrom('Dell Latitude 5490 laptop 32GB RAM, tested working'), table);
  assert.ok(loaded.unitValue > base.unitValue, '32GB should be worth more than the base comp');
});

test('a lot with no comp falls back to the category default at low confidence', () => {
  const value = estimateValue(lotFrom('Assorted unbranded networking switches'), table);
  assert.equal(value.method, 'category');
  assert.ok(value.confidence < 0.3);
});

test('CSV import produces usable comps', () => {
  const comps = parseCompsCsv([
    'id,category,label,terms,unitValue,confidence',
    'my-t480,laptops,"ThinkPad T480, my sold price",thinkpad|t480,175,0.95',
  ].join('\n'));
  assert.equal(comps.length, 1);
  assert.deepEqual(comps[0].match.all, ['thinkpad', 't480']);
  assert.equal(comps[0].unitValue, 175);
  assert.equal(comps[0].label, 'ThinkPad T480, my sold price');
});

test('user comps override the seeded ones by id', () => {
  const merged = mergeTables(table, { comps: [{ id: 'dell-latitude-5490', category: 'laptops', label: 'mine', match: { all: ['latitude', '5490'] }, unitValue: 400, confidence: 0.99 }] });
  const found = findComp(merged, lotFrom('Dell Latitude 5490 laptop'));
  assert.equal(found.comp.unitValue, 400);
  assert.equal(merged.comps.length, table.comps.length, 'an override replaces rather than appends');
});
