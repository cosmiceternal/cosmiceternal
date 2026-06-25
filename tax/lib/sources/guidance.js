'use strict';

/* IRS guidance published in the Federal Register, via the official, key-free
 * Federal Register API (federalregister.gov/api/v1).
 *
 * Covers the IRS-authored documents that appear in the FR: Treasury Decisions
 * (final regulations), proposed regulations, and notices. This is the
 * "everything in between" beyond the codified regulations in 26 C.F.R.
 *
 * Note: Revenue Rulings and Revenue Procedures are published only in the
 * Internal Revenue Bulletin, which has no public API, so they are out of
 * automated scope here. The README is explicit about this. */

const cfg = require('../config');
const http = require('../http');
const { TtlLru } = require('../cache');

const cache = new TtlLru();
const AGENCY = 'internal-revenue-service';

function label(doc) {
  const type = doc.type || 'Document';
  const date = doc.publication_date ? ` (${doc.publication_date})` : '';
  return `${type}: ${doc.title || doc.document_number}${date}`;
}

/* Full-text search of IRS documents in the Federal Register. */
async function search(query, limit = 20) {
  const fields = ['document_number', 'title', 'type', 'publication_date', 'abstract', 'html_url']
    .map((f) => `fields[]=${f}`).join('&');
  const url = `${cfg.federalRegister.base}/api/v1/documents.json` +
    `?conditions[term]=${encodeURIComponent(query)}` +
    `&conditions[agencies][]=${AGENCY}` +
    `&per_page=${Math.min(limit, 100)}&order=relevance&${fields}`;
  const data = await http.getJson(url, { timeoutMs: cfg.http.timeoutMs });
  const results = data?.results || [];
  return results.map((d) => ({
    type: 'guidance',
    ref: d.document_number,
    citation: label(d),
    heading: d.title || null,
    excerpt: (d.abstract || '').trim() || null,
    dateIssued: d.publication_date || null,
    sourceUrl: d.html_url || null
  }));
}

/* Fetch the full plain text of one FR document by its document number. */
async function getDocument(docNumber) {
  const ref = String(docNumber || '').trim();
  if (!ref) { const e = new Error('A Federal Register document number is required.'); e.status = 400; throw e; }
  return cache.wrap(`guidance:${ref}`, async () => {
    try {
      const fields = ['document_number', 'title', 'type', 'publication_date', 'abstract', 'html_url', 'raw_text_url', 'body_html_url']
        .map((f) => `fields[]=${f}`).join('&');
      const meta = await http.getJson(
        `${cfg.federalRegister.base}/api/v1/documents/${encodeURIComponent(ref)}.json?${fields}`,
        { timeoutMs: cfg.http.timeoutMs }
      );
      let text = '';
      if (meta.raw_text_url) {
        text = (await http.getText(meta.raw_text_url, { timeoutMs: cfg.http.timeoutMs })).trim();
      } else if (meta.body_html_url) {
        text = http.stripMarkup(await http.getText(meta.body_html_url, { timeoutMs: cfg.http.timeoutMs }));
      }
      if (!text) text = (meta.abstract || '').trim();
      if (!text) return { ok: false, ref, errors: ['Federal Register returned no document text'] };
      return {
        ok: true,
        type: 'guidance',
        ref,
        citation: label(meta),
        heading: meta.title || null,
        text,
        strategy: 'federal-register',
        dateIssued: meta.publication_date || null,
        sourceUrl: meta.html_url || null
      };
    } catch (e) {
      return { ok: false, ref, errors: [`federal-register: ${e.message}`] };
    }
  });
}

module.exports = { search, getDocument, _internal: { label } };
