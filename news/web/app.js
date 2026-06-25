'use strict';

// News Wall — a grid of live "stations" (one per topic). Each tile rotates
// through its latest headlines so the wall feels live. Hovering magnifies a
// tile (handled in CSS) and reveals a peek list; clicking opens a reader that
// stays open until you close it.

const KIND = { politics: 'political', economics: 'financial' };
const SECTION_LABEL = { political: 'Political', financial: 'Financial' };
const ROTATE_MS = 5000;     // headline rotation per tile
const REFRESH_MS = 5 * 60 * 1000; // auto re-fetch each station

const stations = []; // { key, sectionKey, topicKey, kind, title, el, items, idx, timer }

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

function setStatus(msg) {
  document.getElementById('status').textContent = msg;
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
  top.appendChild(el('span', 'badge', st.title));
  const liveTag = el('span', 'live-tag');
  liveTag.appendChild(el('span', 'logo-dot live'));
  liveTag.appendChild(el('span', null, 'LIVE'));
  top.appendChild(liveTag);

  const body = el('div', 'station-body');
  body.appendChild(el('h3', 'station-name', st.title));
  const headline = el('p', 'station-headline', 'Loading live headlines…');
  const meta = el('div', 'station-meta', '');
  const peek = el('ul', 'station-peek');
  body.append(headline, meta, peek);

  tile.append(img, top, body);

  tile.onclick = () => openModal(st);
  tile.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openModal(st);
    }
  };

  st.el = { tile, img, headline, meta, peek };
  return tile;
}

// Show the item at st.idx on its tile.
function paintStation(st) {
  if (!st.items || st.items.length === 0) return;
  const it = st.items[st.idx % st.items.length];
  const { img, headline, meta, peek } = st.el;

  if (it.image) {
    img.style.backgroundImage = `url("${it.image.replace(/"/g, '%22')}")`;
    img.classList.add('show');
  } else {
    img.classList.remove('show');
  }
  headline.textContent = it.title;
  const bits = [];
  if (it.source) bits.push(it.source);
  if (it.date) bits.push(timeAgo(it.date));
  meta.textContent = bits.join('  ·  ');

  // Peek list: the next few headlines (revealed on hover via CSS).
  peek.innerHTML = '';
  for (let i = 1; i <= 4 && i < st.items.length; i++) {
    peek.appendChild(el('li', null, st.items[(st.idx + i) % st.items.length].title));
  }
}

function startRotation(st) {
  clearInterval(st.timer);
  if (!st.items || st.items.length < 2) return;
  st.timer = setInterval(() => {
    st.idx = (st.idx + 1) % st.items.length;
    paintStation(st);
  }, ROTATE_MS + Math.floor(Math.random() * 1500)); // stagger so tiles don't flip in unison
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
      st.el.headline.textContent =
        data.okFeeds === 0 ? 'Source offline — check your connection' : 'No headlines right now';
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
  // Fire them all; the shared server-side cache keeps this cheap.
  await Promise.allSettled(stations.map(fetchStation));
  setStatus(`Updated ${new Date().toLocaleTimeString()}`);
}

// ---------------- Modal (click to keep open) ----------------

const modal = {
  root: document.getElementById('modal'),
  head: null,
  section: document.getElementById('modalSection'),
  title: document.getElementById('modalTitle'),
  body: document.getElementById('modalBody'),
  current: null,
};
modal.head = modal.root.querySelector('.modal-head');

function renderArticle(it) {
  const card = el('a', 'article');
  card.href = it.link || '#';
  card.target = '_blank';
  card.rel = 'noopener noreferrer';

  if (it.image) {
    const img = el('img', 'thumb');
    img.src = it.image;
    img.loading = 'lazy';
    img.alt = '';
    img.onerror = () => img.replaceWith(el('div', 'thumb placeholder', '📰'));
    card.appendChild(img);
  } else {
    card.appendChild(el('div', 'thumb placeholder', '📰'));
  }

  const b = el('div', 'art-body');
  b.appendChild(el('h3', 'art-title', it.title));
  const meta = el('div', 'art-meta');
  if (it.source) meta.appendChild(el('span', null, it.source));
  if (it.source && it.date) meta.appendChild(el('span', 'dot', '·'));
  if (it.date) meta.appendChild(el('span', null, timeAgo(it.date)));
  b.appendChild(meta);
  if (it.summary) b.appendChild(el('p', 'art-summary', it.summary));
  card.appendChild(b);
  return card;
}

function fillModal(st) {
  modal.section.textContent = `${SECTION_LABEL[st.kind]} Station · LIVE`;
  modal.title.textContent = st.title;
  modal.head.classList.remove('political', 'financial');
  modal.head.classList.add(st.kind);
  modal.body.innerHTML = '';
  if (!st.items || st.items.length === 0) {
    modal.body.appendChild(el('div', 'empty', 'No headlines available right now.'));
    return;
  }
  st.items.forEach((it) => modal.body.appendChild(renderArticle(it)));
}

function openModal(st) {
  modal.current = st;
  fillModal(st);
  modal.root.classList.remove('hidden');
}

function closeModal() {
  modal.root.classList.add('hidden');
  modal.current = null;
}

document.getElementById('modalClose').onclick = closeModal;
modal.root.querySelector('.modal-backdrop').onclick = closeModal;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modal.root.classList.contains('hidden')) closeModal();
});
document.getElementById('modalRefresh').onclick = async (e) => {
  if (!modal.current) return;
  e.currentTarget.classList.add('spin');
  await fetchStation(modal.current);
  fillModal(modal.current);
  e.currentTarget.classList.remove('spin');
};

// ---------------- Filters / controls ----------------

function applyFilter(kind) {
  for (const st of stations) {
    st.el.tile.style.display = kind === 'all' || st.kind === kind ? '' : 'none';
  }
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
  tick();
  setInterval(tick, 1000);
}

// ---------------- Init ----------------

async function init() {
  wireControls();

  let manifest;
  try {
    manifest = await (await fetch('/api/topics')).json();
  } catch {
    setStatus('Server not reachable.');
    return;
  }

  const wall = document.getElementById('wall');
  for (const [sectionKey, section] of Object.entries(manifest)) {
    const kind = KIND[sectionKey] || 'political';
    for (const [topicKey, title] of Object.entries(section.topics)) {
      const st = { key: `${sectionKey}:${topicKey}`, sectionKey, topicKey, kind, title, items: [], idx: 0, timer: null };
      stations.push(st);
      wall.appendChild(makeStationEl(st));
    }
  }

  await loadAll();
  setInterval(loadAll, REFRESH_MS); // keep the wall live
}

init();
