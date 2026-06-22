#!/usr/bin/env node
'use strict';

// server.js — a tiny local web server for the visual news reader.
//
//   node server.js            then open http://localhost:8787
//   PORT=9000 node server.js  use a different port
//
// It serves the page from ./web and exposes two JSON endpoints. The browser
// can't fetch most RSS feeds directly (cross-origin restrictions), so the
// server fetches and parses them, then hands the browser clean JSON.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { SECTIONS } = require('./feeds');
const { loadTopic } = require('./feedlib');

const PORT = process.env.PORT || 8787;
const WEB_DIR = path.join(__dirname, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// A trimmed version of the topic tree, safe to expose to the browser
// (titles + keys only — no internal feed lists needed client-side).
function topicsManifest() {
  const out = {};
  for (const [sk, section] of Object.entries(SECTIONS)) {
    out[sk] = { title: section.title, topics: {} };
    for (const [tk, topic] of Object.entries(section.children)) {
      out[sk].topics[tk] = topic.title;
    }
  }
  return out;
}

function serveStatic(req, res, urlPath) {
  // Default document.
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  // Prevent path traversal.
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(WEB_DIR, safe);
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/topics') {
    return sendJson(res, 200, topicsManifest());
  }

  if (url.pathname === '/api/topic') {
    const sectionKey = url.searchParams.get('section');
    const topicKey = url.searchParams.get('topic') || 'top';
    const section = SECTIONS[sectionKey];
    const topic = section && section.children[topicKey];
    if (!topic) return sendJson(res, 404, { error: 'Unknown section/topic' });
    try {
      const loaded = await loadTopic(topic);
      return sendJson(res, 200, {
        title: topic.title,
        section: section.title,
        ...loaded,
        items: loaded.items.map((it) => ({
          title: it.title,
          link: it.link,
          summary: it.summary,
          image: it.image,
          source: it.source,
          date: it.date ? it.date.toISOString() : null,
        })),
      });
    } catch (err) {
      return sendJson(res, 502, { error: 'Failed to load feeds', detail: err.message });
    }
  }

  serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`\n  News reader running.  Open  http://localhost:${PORT}\n`);
  console.log('  Press Ctrl+C to stop.\n');
});
