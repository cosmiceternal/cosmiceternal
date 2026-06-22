'use strict';

/* Code of Federal Regulations, Title 26 — the Treasury/IRS regulations that
 * interpret the statute. The eCFR has a clean, official, public REST API
 * (no key required), so this is the most structured of our sources.
 *
 *   - Section text: GET /api/versioner/v1/full/<date>/title-26.xml?part=&section=
 *   - Full-text search: GET /api/search/v1/results?query=&conditions[hierarchy][title]=26
 *
 * Requires outbound network access at runtime. */

const cfg = require('../config');
const http = require('../http');
const citation = require('../citation');
const { TtlLru } = require('../cache');

const cache = new TtlLru();

/* eCFR's versioner needs a concrete date. Ask the titles index for how current
 * Title 26 is and reuse that date (cached for the process). */
async function latestDate() {
  return cache.wrap('ecfr:date', async () => {
    const data = await http.getJson(`${cfg.ecfr.base}/api/versioner/v1/titles.json`, { timeoutMs: cfg.http.timeoutMs });
    const titles = data?.titles || [];
    const t26 = titles.find((t) => Number(t.number) === 26) || {};
    return t26.up_to_date_as_of || t26.latest_issue_date || new Date().toISOString().slice(0, 10);
  });
}

function partOf(section) {
  const dot = section.indexOf('.');
  return dot > 0 ? section.slice(0, dot) : section;
}

async function getSection(parsed) {
  return cache.wrap(`ecfr:section:${parsed.section}`, async () => {
    try {
      const date = await latestDate();
      const part = partOf(parsed.section);
      const url = `${cfg.ecfr.base}/api/versioner/v1/full/${encodeURIComponent(date)}/title-26.xml` +
        `?part=${encodeURIComponent(part)}&section=${encodeURIComponent(parsed.section)}`;
      const xml = await http.getText(url, { timeoutMs: cfg.http.timeoutMs });
      const text = http.stripMarkup(xml);
      if (!text || text.length < 20) return { ok: false, citation: parsed.label, errors: ['eCFR returned no section text'] };
      const links = citation.urls(parsed, { cornellBase: cfg.cornell.base, ecfrBase: cfg.ecfr.base });
      return {
        ok: true,
        citation: parsed.label,
        type: 'cfr',
        section: parsed.section,
        heading: extractHeading(xml),
        text,
        strategy: 'ecfr',
        dateIssued: date,
        sourceUrl: links.ecfr,
        links
      };
    } catch (e) {
      return { ok: false, citation: parsed.label, errors: [`ecfr: ${e.message}`] };
    }
  });
}

// The first <HEAD> in the section XML is its heading, e.g. "§ 1.61-1 ...".
function extractHeading(xml) {
  const m = /<HEAD>([\s\S]*?)<\/HEAD>/i.exec(xml || '');
  return m ? http.stripMarkup(m[1]) : null;
}

async function search(query, limit = 20) {
  const url = `${cfg.ecfr.base}/api/search/v1/results` +
    `?query=${encodeURIComponent(query)}&conditions[hierarchy][title]=26&per_page=${Math.min(limit, 100)}`;
  const data = await http.getJson(url, { timeoutMs: cfg.http.timeoutMs });
  const results = data?.results || [];
  return results.map((r) => {
    const h = r.hierarchy || {};
    const section = h.section || null;
    const parsed = section ? citation.parse(section) : null;
    return {
      type: 'cfr',
      section,
      citation: parsed ? parsed.label : (section ? `26 C.F.R. § ${section}` : null),
      heading: (r.hierarchy_headings && r.hierarchy_headings.section) || r.headings?.section || null,
      excerpt: (r.full_text_excerpt || '').replace(/<[^>]+>/g, ''),
      sourceUrl: parsed ? citation.urls(parsed, { ecfrBase: cfg.ecfr.base }).ecfr : null
    };
  });
}

module.exports = { getSection, search, latestDate, _internal: { extractHeading, partOf } };
