'use strict';

// News Wall front-end: a grid of live "stations" (one per topic). Tiles rotate
// through their latest headlines; foreign stations show English subtitles.
// Hover magnifies (CSS); click opens a reader that stays open; the speaker
// button reads a headline aloud with the browser's built-in voice. A right-
// hand rail shows international market indexes.

const KIND = { politics: 'political', economics: 'financial', world: 'world' };
const SECTION_LABEL = { political: 'Political', financial: 'Financial', world: 'World' };
const ROTATE_MS = 5000;
const REFRESH_MS = 5 * 60 * 1000;
const MARKETS_MS = 60 * 1000;

const stations = [];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function timeAgo(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function setStatus(msg) { document.getElementById('status').textContent = msg; }

// English headline if a (different) translation exists, else the original.
function displayTitle(it) {
  return it.titleEn && it.titleEn !== it.title ? it.titleEn : it.title;
}

// ---------------- Speech (the read-aloud "voice") ----------------

let speakingBtn = null;
function speak(text, btn) {
  if (!('speechSynthesis' in window)) return;
  const synth = window.speechSynthesis;
  const wasSame = speakingBtn === btn;
  synth.cancel();
  if (speakingBtn) speakingBtn.classList.remove('speaking');
  if (wasSame || !text) { speakingBtn = null; return; } // toggle off
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  u.onend = () => { btn && btn.classList.remove('speaking'); if (speakingBtn === btn) speakingBtn = null; };
  if (btn) btn.classList.add('speaking');
  speakingBtn = btn;
  synth.speak(u);
}

// ---------------- Build tiles ----------------

function makeStationEl(st) {
  const tile = el('div', `station ${st.kind} loading`);
  tile.tabIndex = 0;
  tile.setAttribute('role', 'button');
  tile.setAttribute('aria-label', `${st.title} — open station`);
  tile.dataset.kind = st.kind;

  const img = el('div', 'station-img');

  const top = el('div', 'station-top');
  top.appendChild(el('span', 'badge', SECTION_LABEL[st.kind]));
  const right = el('div', 'top-right');
  if (st.country) right.appendChild(el('span', 'flag', st.country));
  const liveTag = el('span', 'live-tag');
  liveTag.appendChild(el('span', 'logo-dot live'));
  liveTag.appendChild(el('span', null, 'LIVE'));
  right.appendChild(liveTag);
  const spk = el('button', 'spk', '🔊');
  spk.title = 'Read headline aloud';
  spk.onclick = (e) => { e.stopPropagation(); const it = st.items[st.idx % (st.items.length || 1)]; if (it) speak(displayTitle(it), spk); };
  right.appendChild(spk);
  top.appendChild(right);

  const body = el('div', 'station-body');
  const name = el('h3', 'station-name');
  name.appendChild(el('span', null, st.title));
  body.appendChild(name);
  const headline = el('p', 'station-headline', 'Loading live headlines…');
  const sub = el('p', 'station-sub');
  const meta = el('div', 'station-meta', '');
  const peek = el('ul', 'station-peek');
  body.append(headline, sub, meta, peek);

  tile.append(img, top, body);

  tile.onclick = () => openModal(st);
  tile.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openModal(st); } };

  st.el = { tile, img, headline, sub, meta, peek, spk };
  return tile;
}

function paintStation(st) {
  if (!st.items || st.items.length === 0) return;
  const it = st.items[st.idx % st.items.length];
  const { img, headline, sub, meta, peek } = st.el;

  if (it.image) {
    img.style.backgroundImage = `url("${it.image.replace(/"/g, '%22')}")`;
    img.classList.add('show');
  } else {
    img.classList.remove('show');
  }

  const en = displayTitle(it);
  headline.textContent = en;
  // Subtitle line: original-language headline when we translated it.
  sub.textContent = it.titleEn && it.titleEn !== it.title ? it.title : '';

  const bits = [];
  if (it.source) bits.push(it.source);
  if (it.date) bits.push(timeAgo(it.date));
  meta.textContent = bits.join('  ·  ');

  peek.innerHTML = '';
  for (let i = 1; i <= 4 && i < st.items.length; i++) {
    peek.appendChild(el('li', null, displayTitle(st.items[(st.idx + i) % st.items.length])));
  }
}

function startRotation(st) {
  clearInterval(st.timer);
  if (!st.items || st.items.length < 2) return;
  st.timer = setInterval(() => {
    st.idx = (st.idx + 1) % st.items.length;
    paintStation(st);
  }, ROTATE_MS + Math.floor(Math.random() * 1500));
}

// ---------------- Data ----------------

async function fetchStation(st) {
  try {
    const res = await fetch(`/api/topic?section=${st.sectionKey}&topic=${st.topicKey}`);
    const data = await res.json();
    st.items = data.items || [];
    st.idx = 0;
    st.el.tile.classList.remove('loading', 'offline');
    if (st.items.length === 0) {
      st.el.tile.classList.add('offline');
      st.el.headline.textContent = data.okFeeds === 0 ? 'Source offline — check your connection' : 'No headlines right now';
      st.el.sub.textContent = '';
      st.el.meta.textContent = '';
    } else {
      paintStation(st);
      startRotation(st);
    }
  } catch {
    st.el.tile.classList.add('offline');
    st.el.headline.textContent = 'Could not load station';
  }
}

async function loadAll() {
  setStatus('Loading stations…');
  await Promise.allSettled(stations.map(fetchStation));
  setStatus(`Updated ${new Date().toLocaleTimeString()}`);
}

// ---------------- Markets rail ----------------

function fmtPrice(p) {
  if (p == null) return '—';
  return p.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function renderMarkets(list) {
  const box = document.getElementById('markets');
  box.innerHTML = '';
  if (!list || list.length === 0) {
    box.appendChild(el('div', 'rail-empty', 'Market data unavailable right now.'));
    return;
  }
  for (const m of list) {
    const row = el('div', 'mkt');
    const name = el('div', 'mkt-name');
    name.appendChild(el('span', 'flag', m.flag || ''));
    name.appendChild(el('span', null, m.name));
    row.appendChild(name);
    row.appendChild(el('div', 'mkt-val', fmtPrice(m.price)));
    let cls = 'flat', txt = '—';
    if (m.pct != null) {
      cls = m.pct > 0.001 ? 'up' : m.pct < -0.001 ? 'down' : 'flat';
      const arrow = cls === 'up' ? '▲' : cls === 'down' ? '▼' : '·';
      txt = `${arrow} ${Math.abs(m.pct).toFixed(2)}%`;
    }
    row.appendChild(el('div', `mkt-chg ${cls}`, txt));
    box.appendChild(row);
  }
}

async function loadMarkets() {
  try {
    const data = await (await fetch('/api/markets')).json();
    renderMarkets(data.indices || []);
  } catch {
    renderMarkets([]);
  }
}

// ---------------- Modal (click to keep open) ----------------

const modal = {
  root: document.getElementById('modal'),
  head: document.getElementById('modal').querySelector('.modal-head'),
  section: document.getElementById('modalSection'),
  title: document.getElementById('modalTitle'),
  body: document.getElementById('modalBody'),
  current: null,
};

function renderArticle(it, foreign) {
  const card = el('div', 'article');

  if (it.image) {
    const img = el('img', 'thumb');
    img.src = it.image; img.loading = 'lazy'; img.alt = '';
    img.onerror = () => img.replaceWith(el('div', 'thumb placeholder', '📰'));
    card.appendChild(img);
  } else {
    card.appendChild(el('div', 'thumb placeholder', '📰'));
  }

  const b = el('div', 'art-body');

  const rowTop = el('div', 'art-row-top');
  const titleWrap = el('div', null);
  const h = el('h3', 'art-title');
  const link = el('a', null, displayTitle(it));
  link.href = it.link || '#'; link.target = '_blank'; link.rel = 'noopener noreferrer';
  h.appendChild(link);
  titleWrap.appendChild(h);
  if (it.titleEn && it.titleEn !== it.title) titleWrap.appendChild(el('div', 'art-original', it.title));
  rowTop.appendChild(titleWrap);

  const spk = el('button', 'spk', '🔊');
  spk.title = 'Read aloud';
  rowTop.appendChild(spk);
  b.appendChild(rowTop);

  const meta = el('div', 'art-meta');
  if (it.source) meta.appendChild(el('span', null, it.source));
  if (it.source && it.date) meta.appendChild(el('span', 'dot', '·'));
  if (it.date) meta.appendChild(el('span', null, timeAgo(it.date)));
  b.appendChild(meta);

  let summaryEl = null;
  if (it.summary) {
    summaryEl = el('p', 'art-summary' + (foreign ? ' untranslated' : ''), it.summary);
    b.appendChild(summaryEl);
  }

  spk.onclick = () => speak(`${displayTitle(it)}. ${summaryEl ? summaryEl.textContent : ''}`, spk);

  card.appendChild(b);
  return { card, summaryEl };
}

async function translateSummaries(st, list) {
  for (const { summaryEl, it } of list) {
    try {
      const res = await fetch(`/api/translate?sl=${encodeURIComponent(st.lang)}&text=${encodeURIComponent(it.summary)}`);
      const data = await res.json();
      if (data.text) { summaryEl.textContent = data.text; summaryEl.classList.remove('untranslated'); }
    } catch { /* keep original */ }
  }
}

function fillModal(st) {
  const foreign = !!(st.lang && st.lang !== 'en');
  modal.section.textContent = `${SECTION_LABEL[st.kind]} Station · LIVE${foreign ? ' · translated' : ''}`;
  modal.title.textContent = (st.country ? st.country + ' ' : '') + st.title;
  modal.head.classList.remove('political', 'financial', 'world');
  modal.head.classList.add(st.kind);
  modal.body.innerHTML = '';
  if (!st.items || st.items.length === 0) {
    modal.body.appendChild(el('div', 'empty', 'No headlines available right now.'));
    return;
  }
  const toTranslate = [];
  st.items.forEach((it) => {
    const { card, summaryEl } = renderArticle(it, foreign);
    modal.body.appendChild(card);
    if (foreign && summaryEl) toTranslate.push({ summaryEl, it });
  });
  if (foreign && toTranslate.length) translateSummaries(st, toTranslate);
}

function openModal(st) { modal.current = st; fillModal(st); modal.root.classList.remove('hidden'); }
function closeModal() { window.speechSynthesis && window.speechSynthesis.cancel(); modal.root.classList.add('hidden'); modal.current = null; }

document.getElementById('modalClose').onclick = closeModal;
modal.root.querySelector('.modal-backdrop').onclick = closeModal;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.root.classList.contains('hidden')) closeModal(); });
document.getElementById('modalRefresh').onclick = async (e) => {
  if (!modal.current) return;
  e.currentTarget.classList.add('spin');
  await fetchStation(modal.current);
  fillModal(modal.current);
  e.currentTarget.classList.remove('spin');
};

// ---------------- Filters / controls ----------------

function applyFilter(kind) {
  for (const st of stations) st.el.tile.style.display = kind === 'all' || st.kind === kind ? '' : 'none';
}

function wireControls() {
  document.querySelectorAll('.filter').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('.filter').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      applyFilter(btn.dataset.kind);
    };
  });
  document.getElementById('refreshAll').onclick = (e) => {
    e.currentTarget.disabled = true;
    loadAll().finally(() => (e.currentTarget.disabled = false));
  };
  const clock = document.getElementById('clock');
  const tick = () => (clock.textContent = new Date().toLocaleTimeString());
  tick(); setInterval(tick, 1000);
}

// ---------------- Init ----------------

async function init() {
  wireControls();

  let manifest;
  try { manifest = await (await fetch('/api/topics')).json(); }
  catch { setStatus('Server not reachable.'); return; }

  const wall = document.getElementById('wall');
  for (const [sectionKey, section] of Object.entries(manifest)) {
    const kind = KIND[sectionKey] || 'political';
    for (const [topicKey, t] of Object.entries(section.topics)) {
      const meta = typeof t === 'string' ? { title: t, lang: 'en', country: '' } : t;
      const st = { key: `${sectionKey}:${topicKey}`, sectionKey, topicKey, kind, title: meta.title, lang: meta.lang || 'en', country: meta.country || '', items: [], idx: 0, timer: null };
      stations.push(st);
      wall.appendChild(makeStationEl(st));
    }
  }

  await loadAll();
  setInterval(loadAll, REFRESH_MS);

  loadMarkets();
  setInterval(loadMarkets, MARKETS_MS);
}

init();
