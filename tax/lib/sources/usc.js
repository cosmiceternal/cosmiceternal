'use strict';

/* United States Code, Title 26 (the Internal Revenue Code) — the statute.
 *
 * Two independent strategies so a hiccup in one doesn't take the feature down:
 *
 *  1. govinfo (GPO) — the authoritative API. We search the USCODE collection
 *     for the section to resolve its granule, then download the granule's
 *     plain-text rendition. This is the source of record.
 *  2. Cornell LII — deterministic per-section URLs (/uscode/text/26/<sec>).
 *     Used as a fallback for verbatim text when govinfo is unavailable.
 *
 * Both require outbound network access at runtime. govinfo light use works with
 * the built-in DEMO_KEY; set GOVINFO_API_KEY (free at api.data.gov) for headroom. */

const cfg = require('../config');
const http = require('../http');
const citation = require('../citation');
const { TtlLru } = require('../cache');

const cache = new TtlLru();

function withKey(url) {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}api_key=${encodeURIComponent(cfg.govinfo.apiKey)}`;
}

/* POST the govinfo search API, scoped to Title 26 of the US Code. */
async function govSearch(query, pageSize = 20) {
  const url = withKey(`${cfg.govinfo.base}/search`);
  const payload = {
    query: `collection:USCODE AND title:26 AND (${query})`,
    pageSize,
    offsetMark: '*',
    sorts: [{ field: 'relevancy', sortOrder: 'DESC' }],
    historical: false,
    resultLevel: 'default'
  };
  const data = await http.postJson(url, payload, { timeoutMs: cfg.http.timeoutMs });
  return Array.isArray(data?.results) ? data.results : [];
}

// USCODE granule ids end with "...-sec<NUMBER>" (e.g. ...-sec61). Match the
// section we asked for so a keyword search doesn't hand back a neighbour.
function granuleMatchesSection(granuleId, section) {
  if (!granuleId) return false;
  return new RegExp(`-sec${section}$`, 'i').test(granuleId);
}

async function govSectionText(parsed) {
  const results = await govSearch(`section:${parsed.section} OR "${parsed.section}"`, 25);
  const hit = results.find((r) => granuleMatchesSection(r.granuleId, parsed.section)) || null;
  if (!hit) return null;

  const summaryUrl = withKey(
    `${cfg.govinfo.base}/packages/${encodeURIComponent(hit.packageId)}/granules/${encodeURIComponent(hit.granuleId)}/summary`
  );
  const summary = await http.getJson(summaryUrl, { timeoutMs: cfg.http.timeoutMs });
  const txtLink = summary?.download?.txtLink;
  const htmLink = summary?.download?.htmLink;
  let text = '';
  if (txtLink) {
    text = await http.getText(withKey(txtLink), { timeoutMs: cfg.http.timeoutMs });
  } else if (htmLink) {
    text = http.stripMarkup(await http.getText(withKey(htmLink), { timeoutMs: cfg.http.timeoutMs }));
  }
  text = (text || '').trim();
  if (!text) return null;
  return {
    text,
    strategy: 'govinfo',
    heading: summary?.title || hit.title || null,
    dateIssued: summary?.dateIssued || hit.dateIssued || null,
    sourceUrl: summary?.detailsLink || hit.detailsLink || null
  };
}

// Cornell renders the section body inside the field-items region. We grab from
// the first content block to the "U.S. Code Toolbox" chrome and strip markup.
function extractCornellBody(html) {
  if (!html) return '';
  let region = html;
  const startIdx = html.search(/<div[^>]*class="[^"]*field-item[^"]*"/i);
  if (startIdx >= 0) region = html.slice(startIdx);
  const endIdx = region.search(/U\.S\. Code Toolbox|<div[^>]*id="[^"]*usc-toolbox/i);
  if (endIdx > 0) region = region.slice(0, endIdx);
  return http.stripMarkup(region);
}

async function cornellSectionText(parsed) {
  const url = `${cfg.cornell.base}/uscode/text/26/${encodeURIComponent(parsed.section)}`;
  const res = await http.request(url, { timeoutMs: cfg.http.timeoutMs });
  if (!res.ok) {
    if (res.status === 404) return null;
    const e = new Error(`Cornell HTTP ${res.status}`); e.status = res.status; throw e;
  }
  const body = extractCornellBody(await res.text());
  if (!body || body.length < 20) return null;
  return { text: body, strategy: 'cornell', heading: null, dateIssued: null, sourceUrl: url };
}

/* Fetch verbatim text for a parsed USC citation. Tries govinfo first, then
 * Cornell. Each error is captured so the caller can explain a total failure. */
async function getSection(parsed) {
  return cache.wrap(`usc:section:${parsed.section}`, async () => {
    const errors = [];
    for (const fn of [govSectionText, cornellSectionText]) {
      try {
        const out = await fn(parsed);
        if (out) return { ok: true, ...buildResult(parsed, out) };
      } catch (e) {
        errors.push(`${fn.name}: ${e.message}`);
      }
    }
    return { ok: false, citation: parsed.label, errors };
  });
}

function buildResult(parsed, out) {
  const links = citation.urls(parsed, { cornellBase: cfg.cornell.base, ecfrBase: cfg.ecfr.base });
  return {
    citation: parsed.label,
    type: 'usc',
    section: parsed.section,
    heading: out.heading,
    text: out.text,
    strategy: out.strategy,
    dateIssued: out.dateIssued,
    sourceUrl: out.sourceUrl || links.cornell,
    links
  };
}

/* Full-text search across Title 26 of the US Code via govinfo. */
async function search(query, limit = 20) {
  const results = await govSearch(`"${query.replace(/"/g, '')}"`, limit);
  return results.map((r) => {
    const m = /-sec([0-9A-Za-z]+)$/.exec(r.granuleId || '');
    const section = m ? m[1] : null;
    const parsed = section ? citation.parse(section) : null;
    return {
      type: 'usc',
      section,
      citation: parsed ? parsed.label : (r.title || null),
      heading: r.title || null,
      dateIssued: r.dateIssued || null,
      packageId: r.packageId,
      granuleId: r.granuleId,
      sourceUrl: r.detailsLink || (parsed ? citation.urls(parsed, { cornellBase: cfg.cornell.base }).cornell : null)
    };
  });
}

module.exports = { getSection, search, _internal: { extractCornellBody, granuleMatchesSection } };
