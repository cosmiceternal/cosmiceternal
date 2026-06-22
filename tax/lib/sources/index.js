'use strict';

/* Unified entry point over the statute (USC Title 26) and regulation (CFR
 * Title 26) sources. The route layer talks only to this module. */

const citation = require('../citation');
const usc = require('./usc');
const ecfr = require('./ecfr');

/* Look up a verbatim section from a free-form citation. Routing is by the
 * parsed citation type: "1.61-1" → CFR, "61" → USC. */
async function getSection(rawCitation) {
  const parsed = citation.parse(rawCitation);
  if (!parsed) {
    const err = new Error(`Could not recognize "${rawCitation}" as a Title 26 citation.`);
    err.status = 400;
    throw err;
  }
  const out = parsed.type === 'cfr' ? await ecfr.getSection(parsed) : await usc.getSection(parsed);
  return { parsed, ...out };
}

/* Full-text search. scope: 'all' | 'usc' | 'cfr'. Failures in one corpus don't
 * sink the other — we return whatever came back plus any per-source errors. */
async function search(query, { scope = 'all', limit = 20 } = {}) {
  const q = String(query || '').trim();
  if (!q) {
    const err = new Error('Empty search query.'); err.status = 400; throw err;
  }
  const jobs = [];
  if (scope === 'all' || scope === 'usc') jobs.push(tagged('usc', usc.search(q, limit)));
  if (scope === 'all' || scope === 'cfr') jobs.push(tagged('cfr', ecfr.search(q, limit)));
  const settled = await Promise.all(jobs);

  const results = [];
  const errors = [];
  for (const s of settled) {
    if (s.ok) results.push(...s.value);
    else errors.push({ source: s.source, error: s.error });
  }
  return { query: q, scope, count: results.length, results, errors };
}

async function tagged(source, promise) {
  try { return { source, ok: true, value: await promise }; }
  catch (e) { return { source, ok: false, error: e.message }; }
}

module.exports = { getSection, search };
