'use strict';

// Front-end for the visual news reader. Talks to the local server's
// /api endpoints; the server does all the feed fetching and parsing.

const state = {}; // per-section: { activeTopic }

function timeAgo(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

// Build the article cards for one column's feed area.
function renderFeed(feedEl, data) {
  feedEl.innerHTML = '';
  if (!data.items || data.items.length === 0) {
    const m = el('div', 'empty');
    if (data.okFeeds === 0) {
      m.textContent = 'Could not reach any news source. Check your internet connection.';
    } else {
      m.textContent = 'No matching headlines right now — try another topic or refresh.';
    }
    feedEl.appendChild(m);
    return;
  }

  for (const it of data.items) {
    const card = el('a', 'article');
    card.href = it.link || '#';
    card.target = '_blank';
    card.rel = 'noopener noreferrer';

    if (it.image) {
      const img = el('img', 'thumb');
      img.src = it.image;
      img.loading = 'lazy';
      img.alt = '';
      // If an image 404s, swap in the placeholder.
      img.onerror = () => {
        const ph = el('div', 'thumb placeholder', '📰');
        img.replaceWith(ph);
      };
      card.appendChild(img);
    } else {
      card.appendChild(el('div', 'thumb placeholder', '📰'));
    }

    const body = el('div', 'art-body');
    body.appendChild(el('h3', 'art-title', it.title));

    const meta = el('div', 'art-meta');
    if (it.source) meta.appendChild(el('span', null, it.source));
    if (it.source && it.date) meta.appendChild(el('span', 'dot', '·'));
    if (it.date) meta.appendChild(el('span', null, timeAgo(it.date)));
    body.appendChild(meta);

    if (it.summary) body.appendChild(el('p', 'art-summary', it.summary));

    card.appendChild(body);
    feedEl.appendChild(card);
  }
}

async function loadTopic(sectionEl, sectionKey, topicKey) {
  const feedEl = sectionEl.querySelector('.feed');
  feedEl.innerHTML = '<div class="loading">Loading…</div>';
  state[sectionKey].activeTopic = topicKey;

  // Highlight the active tab.
  sectionEl.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.topic === topicKey);
  });

  try {
    const res = await fetch(`/api/topic?section=${sectionKey}&topic=${topicKey}`);
    const data = await res.json();
    renderFeed(feedEl, data);
    setStatus(`Updated ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    feedEl.innerHTML = '<div class="empty">Could not load. Is the server still running?</div>';
  }
}

function buildTabs(sectionEl, sectionKey, topics) {
  const nav = sectionEl.querySelector('.tabs');
  nav.innerHTML = '';
  const keys = Object.keys(topics);
  for (const tk of keys) {
    const tab = el('button', 'tab', topics[tk]);
    tab.dataset.topic = tk;
    tab.onclick = () => loadTopic(sectionEl, sectionKey, tk);
    nav.appendChild(tab);
  }
  return keys;
}

async function init() {
  let manifest;
  try {
    manifest = await (await fetch('/api/topics')).json();
  } catch {
    setStatus('Server not reachable.');
    return;
  }

  document.querySelectorAll('.column').forEach((sectionEl) => {
    const sectionKey = sectionEl.dataset.section;
    const section = manifest[sectionKey];
    if (!section) return;
    state[sectionKey] = { activeTopic: 'top' };
    const keys = buildTabs(sectionEl, sectionKey, section.topics);

    sectionEl.querySelector('.refresh').onclick = (e) => {
      const btn = e.currentTarget;
      btn.classList.add('spin');
      loadTopic(sectionEl, sectionKey, state[sectionKey].activeTopic).finally(() =>
        setTimeout(() => btn.classList.remove('spin'), 600)
      );
    };

    // Load the first topic (top news) by default.
    loadTopic(sectionEl, sectionKey, keys[0]);
  });
}

init();
