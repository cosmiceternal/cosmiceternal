'use strict';

const test = require('node:test');
const assert = require('node:assert');

const n = require('../src/normalize');
const taxonomy = require('../src/taxonomy');

test('money parses US and European separators', () => {
  assert.equal(n.parseMoney('$1,234.56'), 1234.56);
  assert.equal(n.parseMoney('1.234,56'), 1234.56);
  assert.equal(n.parseMoney('USD 900'), 900);
  assert.equal(n.parseMoney(42), 42);
  assert.equal(n.parseMoney(''), null);
  assert.equal(n.parseMoney('no digits here'), null);
});

test('dates parse from ISO, epoch seconds and epoch milliseconds', () => {
  assert.equal(n.parseDate('2026-01-01T00:00:00Z'), '2026-01-01T00:00:00.000Z');
  assert.equal(n.parseDate(1767225600), '2026-01-01T00:00:00.000Z');
  assert.equal(n.parseDate(1767225600000), '2026-01-01T00:00:00.000Z');
  assert.equal(n.parseDate('not a date'), null);
  assert.equal(n.parseDate(null), null);
});

test('quantity is read from the phrasings surplus listings actually use', () => {
  assert.equal(n.parseQuantity('LOT OF 25 DELL LATITUDE 5490 LAPTOPS'), 25);
  assert.equal(n.parseQuantity('(3) Fluke 87V Multimeters'), 3);
  assert.equal(n.parseQuantity('Qty: 30 monitors'), 30);
  assert.equal(n.parseQuantity('12x HP EliteBook'), 12);
  assert.equal(n.parseQuantity('Pallet of approximately 60 chairs'), 60);
});

test('quantity is not fooled by model numbers or port counts', () => {
  assert.equal(n.parseQuantity('Dell Latitude 5490 Laptop'), 1);
  assert.equal(n.parseQuantity('Cisco Catalyst 2960X 48 Port Switch'), 1);
  assert.equal(n.parseQuantity('24" Dell UltraSharp Monitor'), 1);
});

test('condition takes the worst signal in the text', () => {
  assert.equal(n.parseCondition('used, working, sold for parts only'), 'salvage');
  assert.equal(n.parseCondition('Brand new in box'), 'new');
  assert.equal(n.parseCondition('Refurbished by vendor'), 'refurbished');
  assert.equal(n.parseCondition('tested and working'), 'used');
  assert.equal(n.parseCondition('a lot of stuff'), 'unknown');
});

test('specs come out of free-text titles', () => {
  const specs = n.parseSpecs('Dell Latitude 5490 i5-8250U 16GB RAM 512GB SSD 14" laptop');
  assert.equal(specs.cpu, 'i5');
  assert.equal(specs.cpuGen, 8);
  assert.equal(specs.ramGb, 16);
  assert.equal(specs.storageGb, 512);
  assert.equal(specs.storageType, 'ssd');
  assert.equal(specs.screenInches, 14);
});

test('Intel generation handles both four and five digit SKUs', () => {
  assert.equal(n.parseSpecs('i7-1165G7').cpuGen, 11, 'four digits starting with 1 is gen 10+');
  assert.equal(n.parseSpecs('i5-10510U').cpuGen, 10);
  assert.equal(n.parseSpecs('i9-9750H').cpuGen, 9);
});

test('locations resolve to state codes from names, codes and city strings', () => {
  assert.equal(n.parseLocation('Austin, TX 78701').state, 'TX');
  assert.equal(n.parseLocation('Austin, TX 78701').city, 'Austin');
  assert.equal(n.parseLocation('Ohio').state, 'OH');
  assert.equal(n.parseLocation('Columbus, Ohio').state, 'OH');
  assert.equal(n.parseLocation('somewhere unknown').state, null);
});

test('normalizeLot builds a canonical lot and rejects unusable input', () => {
  const lot = n.normalizeLot({
    externalId: '8812',
    title: '  Lot of 25 Dell Latitude 5490 Laptops  ',
    currentBid: '$1,250.00',
    bidCount: 4,
    closesAt: '2026-09-05T18:00:00Z',
    location: 'Austin, TX',
  }, { sourceId: 'govdeals' });

  assert.equal(lot.id, 'govdeals:8812');
  assert.equal(lot.title, 'Lot of 25 Dell Latitude 5490 Laptops');
  assert.equal(lot.category, 'laptops');
  assert.equal(lot.quantity, 25);
  assert.equal(lot.currentBid, 1250);
  assert.equal(lot.location.state, 'TX');
  assert.equal(lot.priceHistory.length, 1);

  assert.throws(() => n.normalizeLot({ title: 'no id' }, { sourceId: 'x' }), /no external id/);
  assert.throws(() => n.normalizeLot({ externalId: '1', title: '  ' }, { sourceId: 'x' }), /no title/);
});

test('vehicles and heavy equipment are never multiplied by a parsed quantity', () => {
  const lot = n.normalizeLot({
    externalId: 'v1',
    title: '2016 Ford F-150 XL Pickup, VIN 1FTMF1C87GKE12345, 4x2',
  }, { sourceId: 'govdeals' });
  assert.equal(lot.category, 'vehicles');
  assert.equal(lot.quantity, 1, 'the "4x2" drivetrain is not a quantity');
});

test('classification picks the right category for real listing titles', () => {
  const cases = [
    ['LOT OF 25 DELL LATITUDE 5490 LAPTOPS', 'laptops'],
    ['Cisco Catalyst 2960X 48 Port Switch', 'networking'],
    ['(3) Fluke 87V Multimeters', 'testequipment'],
    ['Dell PowerEdge R640 Server', 'servers'],
    ['John Deere 310 Backhoe Loader', 'heavyequipment'],
    ['Herman Miller Aeron office chairs', 'furniture'],
    ['Nothing recognisable in here', 'misc'],
  ];
  for (const [title, expected] of cases) {
    assert.equal(taxonomy.classify(title).category, expected, title);
  }
});
