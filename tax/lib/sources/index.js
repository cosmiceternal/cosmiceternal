'use strict';

/* Unified entry point over all corpora:
 *   - USC Title 26   (statute)              — usc.js
 *   - CFR Title 26   (Treasury regulations) — ecfr.js
 *   - IRS guidance   (Federal Register)     — guidance.js
 *   - Federal tax case law (CourtListener)  — caselaw.js
 * The route layer talks only to this module. */

const citation = require('../citation');
const usc = require('./usc');
const ecfr = require('./ecfr');
const guidance = require('./guidance');
const caselaw = require('./caselaw');

const CORPORA = ['usc', 'cfr', 'guidance', 'caselaw'];

/* Look up verbatim text. Statute/regs are addressed by citation; guidance and
 * case law are addressed by their native identifiers. */
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

/* Fetch a guidance document (Federal Register doc number) or a case-law
 * opinion (CourtListener opinion id) by native id. */
async function getDocument({ type, ref } = {}) {
  if (type === 'guidance') return guidance.getDocument(ref);
  if (type === 'caselaw') return caselaw.getOpinion(ref);
  const e = new Error(`Unknown document type "${type}". Expected "guidance" or "caselaw".`);
  e.status = 400; throw e;
}

/* Full-text search. scope: 'all' | 'usc' | 'cfr' | 'guidance' | 'caselaw'.
 * One corpus failing never sinks the others — partial results + per-source
 * errors are returned. */
async function search(query, { scope = 'all', limit = 20 } = {}) {
  const q = String(query || '').trim();
  if (!q) { const err = new Error('Empty search query.'); err.status = 400; throw err; }

  const want = scope === 'all' ? CORPORA : [scope];
  const runner = { usc: usc.search, cfr: ecfr.search, guidance: guidance.search, caselaw: caselaw.search };
  const jobs = want
    .filter((s) => runner[s])
    .map((s) => tagged(s, runner[s](q, limit)));
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

module.exports = { getSection, getDocument, search, CORPORA };
