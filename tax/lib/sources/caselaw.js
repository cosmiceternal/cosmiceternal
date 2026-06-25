'use strict';

/* Federal tax case law via the CourtListener REST API v4 (Free Law Project).
 *
 *   - Search: GET /api/rest/v4/search/?q=&type=o   (type=o → opinions)
 *   - Opinion text: GET /api/rest/v4/opinions/<id>/
 *
 * Works without a token at a lower rate limit; set COURTLISTENER_API_TOKEN for
 * headroom. Requires outbound network access at runtime.
 *
 * Defensive on field names: v4 result shapes vary by index, so we read several
 * likely keys for case name, citation, court, and opinion id. */

const cfg = require('../config');
const http = require('../http');
const { TtlLru } = require('../cache');

const cache = new TtlLru();

function authHeaders() {
  return cfg.courtListener.token ? { Authorization: `Token ${cfg.courtListener.token}` } : {};
}

function pick(obj, keys) {
  for (const k of keys) if (obj && obj[k] != null && obj[k] !== '') return obj[k];
  return null;
}

function firstCitation(r) {
  const c = r.citation || r.citations || r.cite;
  if (Array.isArray(c)) return c[0] || null;
  return c || null;
}

function caseLabel(r) {
  const name = pick(r, ['caseName', 'case_name', 'caseNameFull', 'case_name_full']) || 'Unnamed case';
  const cite = firstCitation(r);
  const court = pick(r, ['court', 'court_id']);
  const date = pick(r, ['dateFiled', 'date_filed']);
  const tail = [cite, court, date].filter(Boolean).join(', ');
  return tail ? `${name}, ${tail}` : name;
}

// A search result can expose the opinion id directly or nest it under opinions[].
function opinionId(r) {
  const direct = pick(r, ['id', 'opinion_id']);
  if (direct) return direct;
  const ops = r.opinions || r.sub_opinions;
  if (Array.isArray(ops) && ops.length) return pick(ops[0], ['id', 'opinion_id', 'download_url']);
  return null;
}

function snippet(r) {
  const ops = r.opinions;
  const snip = (Array.isArray(ops) && ops[0] && ops[0].snippet) || r.snippet || r.text || '';
  return String(snip).replace(/<[^>]+>/g, '').trim() || null;
}

async function search(query, limit = 20) {
  const url = `${cfg.courtListener.base}/api/rest/v4/search/` +
    `?q=${encodeURIComponent(query)}&type=o&order_by=score%20desc`;
  const data = await http.getJson(url, { timeoutMs: cfg.http.timeoutMs, headers: authHeaders() });
  const results = (data?.results || []).slice(0, limit);
  return results.map((r) => ({
    type: 'caselaw',
    ref: opinionId(r) != null ? String(opinionId(r)) : null,
    citation: caseLabel(r),
    heading: pick(r, ['court', 'court_id']),
    excerpt: snippet(r),
    dateIssued: pick(r, ['dateFiled', 'date_filed']),
    sourceUrl: r.absolute_url ? `${cfg.courtListener.base}${r.absolute_url}` : null
  }));
}

/* Full opinion text by opinion id. */
async function getOpinion(id) {
  const ref = String(id || '').trim();
  if (!ref) { const e = new Error('A CourtListener opinion id is required.'); e.status = 400; throw e; }
  return cache.wrap(`caselaw:${ref}`, async () => {
    try {
      const data = await http.getJson(
        `${cfg.courtListener.base}/api/rest/v4/opinions/${encodeURIComponent(ref)}/`,
        { timeoutMs: cfg.http.timeoutMs, headers: authHeaders() }
      );
      let text = (data.plain_text || '').trim();
      if (!text && data.html) text = http.stripMarkup(data.html);
      if (!text && data.html_lawbox) text = http.stripMarkup(data.html_lawbox);
      if (!text) return { ok: false, ref, errors: ['CourtListener returned no opinion text'] };
      const abs = data.absolute_url ? `${cfg.courtListener.base}${data.absolute_url}` : null;
      return {
        ok: true,
        type: 'caselaw',
        ref,
        citation: `Opinion #${ref}`,
        heading: null,
        text,
        strategy: 'courtlistener',
        dateIssued: data.date_created ? String(data.date_created).slice(0, 10) : null,
        sourceUrl: abs
      };
    } catch (e) {
      return { ok: false, ref, errors: [`courtlistener: ${e.message}`] };
    }
  });
}

module.exports = { search, getOpinion, _internal: { caseLabel, opinionId, snippet, firstCitation } };
