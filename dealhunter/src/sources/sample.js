'use strict';

// An offline source backed by fixtures. It exists so `dealhunter demo`, the
// test suite and a first run on a fresh checkout all exercise the real
// pipeline — scrape, value, alert — without touching a live auction site.
// Closing times are stored as offsets and resolved at read time so the demo
// data always looks like a live board.
const fs = require('node:fs');
const path = require('node:path');

const FIXTURE = path.join(__dirname, '..', '..', 'fixtures', 'sample-lots.json');

function loadFixture(file) {
  return JSON.parse(fs.readFileSync(file || FIXTURE, 'utf8'));
}

function createSampleSource(options = {}) {
  const file = options.file || FIXTURE;
  return {
    id: options.id || 'sample',
    label: 'Sample lots (offline fixtures)',
    kind: 'fixture',
    offline: true,
    async collect(ctx = {}) {
      const now = ctx.now ? new Date(ctx.now).getTime() : Date.now();
      const jitter = options.jitter === undefined ? true : options.jitter;
      const records = loadFixture(file).map((lot) => {
        const { closesInHours, ...rest } = lot;
        // Nudge the bid a little each cycle so price-history tracking and the
        // re-alert-on-bid-move path are exercised by the demo too.
        const drift = jitter ? 1 + (Math.random() * 0.04) : 1;
        return {
          ...rest,
          currentBid: Math.round(rest.currentBid * drift * 100) / 100,
          closesAt: new Date(now + (closesInHours || 24) * 3600 * 1000).toISOString(),
        };
      });
      const wanted = options.sourceFilter || ctx.sourceFilter;
      const filtered = wanted ? records.filter((r) => r.source === wanted) : records;
      return { records: filtered, warnings: [], pagesFetched: 0 };
    },
  };
}

module.exports = { createSampleSource, loadFixture, FIXTURE };
