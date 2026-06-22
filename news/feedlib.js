'use strict';

// feedlib.js — shared feed fetching + parsing used by both the terminal
// reader (news.js) and the local web app (server.js). Uses only Node
// built-ins: no API keys, no third-party packages.

const https = require('https');
const http = require('http');

const TIMEOUT_MS = 9000;
const MAX_ITEMS = 18;

// Fetch a URL, following a handful of redirects. Resolves to the body string.
function fetchUrl(url, redirectsLeft = 4) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const lib = url.startsWith('http://') ? http : https;
    const req = lib.get(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (news reader)',
          Accept: 'application/rss+xml, application/xml, text/xml, */*',
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
          const next = new URL(res.headers.location, url).toString();
          return resolve(fetchUrl(next, redirectsLeft - 1));
        }
        if (status !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${status}`));
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (ch) => (data += ch));
        res.on('end', () => {
          if (!settled) {
            settled = true;
            resolve(data);
          }
        });
      }
    );
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

function extractLink(block) {
  const rss = block.match(/<link>([\s\S]*?)<\/link>/i);
  if (rss && rss[1].trim()) return decodeEntities(rss[1]);
  const atom = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  return atom ? atom[1] : '';
}

// Pull a thumbnail/image URL out of a feed item if one is advertised.
function extractImage(block) {
  let m = block.match(/<media:content[^>]+url=["']([^"']+)["']/i);
  if (m) return m[1];
  m = block.match(/<media:thumbnail[^>]+url=["']([^"']+)["']/i);
  if (m) return m[1];
  m = block.match(/<enclosure[^>]+url=["']([^"']+)["'][^>]*type=["']image/i);
  if (m) return m[1];
  m = block.match(/<enclosure[^>]+type=["']image[^"']*["'][^>]*url=["']([^"']+)["']/i);
  if (m) return m[1];
  m = block.match(/<img[^>]+src=["']([^"']+)["']/i); // image embedded in description HTML
  if (m) return m[1];
  return '';
}

function parseDate(block) {
  const raw =
    tag(block, 'pubDate') ||
    tag(block, 'updated') ||
    tag(block, 'published') ||
    tag(block, 'dc:date');
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t);
}

// Identify the source outlet from a feed/site URL, for display.
function sourceFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const map = {
      'npr.org': 'NPR',
      'feeds.npr.org': 'NPR',
      'bbci.co.uk': 'BBC',
      'feeds.bbci.co.uk': 'BBC',
      'thehill.com': 'The Hill',
      'marketwatch.com': 'MarketWatch',
      'feeds.marketwatch.com': 'MarketWatch',
    };
    return map[host] || host;
  } catch {
    return '';
  }
}

function parseFeed(xml, feedUrl) {
  const items = [];
  const blocks = xml.match(/<(item|entry)[\s\S]*?<\/(item|entry)>/gi) || [];
  for (const block of blocks) {
    const title = tag(block, 'title');
    if (!title) continue;
    const link = extractLink(block);
    items.push({
      title,
      link,
      summary: tag(block, 'description') || tag(block, 'summary') || tag(block, 'content'),
      image: extractImage(block),
      date: parseDate(block),
      source: sourceFromUrl(link || feedUrl),
    });
  }
  return items;
}

function matchesKeywords(item, keywords) {
  if (!keywords || keywords.length === 0) return true;
  const hay = `${item.title} ${item.summary}`.toLowerCase();
  return keywords.some((k) => hay.includes(k));
}

// Fetch every feed for a topic, merge, filter, dedupe, sort newest-first.
async function loadTopic(topic) {
  const results = await Promise.allSettled(topic.feeds.map((u) => fetchUrl(u)));

  let items = [];
  let okFeeds = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      okFeeds += 1;
      items = items.concat(parseFeed(r.value, topic.feeds[i]));
    }
  });

  items = items.filter((it) => matchesKeywords(it, topic.keywords));

  const seen = new Set();
  items = items.filter((it) => {
    const key = it.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  items.sort((a, b) => (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0));

  return {
    items: items.slice(0, MAX_ITEMS),
    okFeeds,
    totalFeeds: topic.feeds.length,
  };
}

module.exports = { fetchUrl, parseFeed, matchesKeywords, loadTopic, MAX_ITEMS };
