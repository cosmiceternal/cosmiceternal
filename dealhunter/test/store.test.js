'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { openStore } = require('../src/store/store');
const { tempDir, cleanup } = require('./helpers');

test.after(cleanup);

test('store persists documents across reopen', () => {
  const dir = tempDir();
  const first = openStore(dir).collection('lots');
  first.put({ id: 'a', bid: 1 });
  first.put({ id: 'a', bid: 2 });
  first.putMany([{ id: 'b', bid: 3 }, { id: 'c', bid: 4 }]);
  first.delete('c');

  const reopened = openStore(dir).collection('lots');
  assert.equal(reopened.count(), 2);
  assert.equal(reopened.get('a').bid, 2, 'last write wins on replay');
  assert.equal(reopened.has('c'), false, 'deletes survive replay');
});

test('store returns copies, so callers cannot mutate what is stored', () => {
  const store = openStore(tempDir()).collection('lots');
  store.put({ id: 'a', nested: { bid: 1 } });
  const doc = store.get('a');
  doc.nested.bid = 999;
  assert.equal(store.get('a').nested.bid, 1);
});

test('upsert reads and writes in one step', () => {
  const store = openStore(tempDir()).collection('lots');
  store.upsert('a', (current) => ({ ...(current || {}), seen: (current ? current.seen : 0) + 1 }));
  store.upsert('a', (current) => ({ ...current, seen: current.seen + 1 }));
  assert.equal(store.get('a').seen, 2);
  store.upsert('a', () => undefined);
  assert.equal(store.get('a').seen, 2, 'returning undefined is a no-op');
});

test('compaction shrinks the log without losing data', () => {
  const dir = tempDir();
  const store = openStore(dir).collection('lots');
  for (let i = 0; i < 50; i += 1) store.put({ id: 'a', bid: i });
  assert.equal(store.appends, 50);
  store.compact();
  assert.equal(store.appends, 1);
  assert.equal(openStore(dir).collection('lots').get('a').bid, 49);
});

test('a torn final line does not lose the records before it', () => {
  const dir = tempDir();
  const store = openStore(dir).collection('lots');
  store.put({ id: 'a', bid: 1 });
  store.put({ id: 'b', bid: 2 });
  fs.appendFileSync(path.join(dir, 'lots.ndjson'), '{"o":"p","i":"c","d":{"id":"c"');

  const reopened = openStore(dir).collection('lots');
  assert.equal(reopened.count(), 2);
  assert.equal(reopened.get('b').bid, 2);
});

test('documents must have an id, and collection names are validated', () => {
  const store = openStore(tempDir());
  assert.throws(() => store.collection('lots').put({ bid: 1 }), /needs an id/);
  assert.throws(() => store.collection('../escape'), /invalid collection name/);
});
