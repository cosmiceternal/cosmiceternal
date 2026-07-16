/* Lobby — the casino floor. A searchable, filterable grid of every game
 * with star-to-favorite (persisted in localStorage). Mounts into the game
 * pane like any other game; clicking a card routes through the existing
 * tab-strip click handler so active-tab state and last-game memory stay
 * consistent. */
(function (global) {
  'use strict';

  // Game list + categories come from the shared catalog (js/catalog.js),
  // so renames/additions happen in exactly one place.
  const GAMES = global.GameCatalog.GAMES;
  const CATS = global.GameCatalog.CATS;

  const FAVS_KEY = 'crypt.favs';
  function loadFavs() {
    try { return new Set(JSON.parse(localStorage.getItem(FAVS_KEY) || '[]')); }
    catch (_) { return new Set(); }
  }
  function saveFavs(favs) {
    try { localStorage.setItem(FAVS_KEY, JSON.stringify([...favs])); } catch (_) {}
  }

  function mount(container) {
    let favs = loadFavs();
    let cat = 'all';
    let query = '';

    container.innerHTML = `
      <div class="lobby">
        <div class="lobby-top">
          <h2 class="lobby-title">Casino Floor <span class="muted">· ${GAMES.length} games</span></h2>
          <input id="lobbySearch" class="lobby-search" type="search" placeholder="Search games…" autocomplete="off" />
        </div>
        <div class="lobby-cats" id="lobbyCats">
          ${CATS.map(c => `<button class="lobby-cat${c.key === 'all' ? ' active' : ''}" data-cat="${c.key}">${c.label}</button>`).join('')}
        </div>
        <div class="lobby-grid" id="lobbyGrid"></div>
      </div>`;

    const grid = container.querySelector('#lobbyGrid');
    const search = container.querySelector('#lobbySearch');

    function visible() {
      let list = GAMES;
      if (cat === 'favs') list = list.filter(g => favs.has(g.key));
      else if (cat !== 'all') list = list.filter(g => g.cat === cat);
      if (query) {
        const q = query.toLowerCase();
        list = list.filter(g => g.name.toLowerCase().includes(q) || g.key.includes(q));
      }
      // Favorites float to the front everywhere except the favs tab itself.
      if (cat !== 'favs') list = [...list].sort((a, b) => Number(favs.has(b.key)) - Number(favs.has(a.key)));
      return list;
    }

    function render() {
      const list = visible();
      if (!list.length) {
        grid.innerHTML = `<div class="lobby-empty muted">${cat === 'favs' && !query ? 'No favorites yet — star a game and it lives here.' : 'No games match.'}</div>`;
        return;
      }
      grid.innerHTML = list.map(g => `
        <button class="lobby-card" data-game="${g.key}">
          <span class="lobby-star${favs.has(g.key) ? ' on' : ''}" data-star="${g.key}" title="Favorite">★</span>
          <span class="lobby-icon">${g.icon}</span>
          <span class="lobby-name">${g.name}</span>
          <span class="lobby-tag">${g.tag}</span>
        </button>`).join('');
    }

    grid.addEventListener('click', (e) => {
      const star = e.target.closest('[data-star]');
      if (star) {
        e.stopPropagation();
        const key = star.dataset.star;
        if (favs.has(key)) favs.delete(key); else favs.add(key);
        saveFavs(favs);
        render();
        return;
      }
      const card = e.target.closest('.lobby-card');
      if (!card) return;
      // Route through the central navigation so active state + last-game memory
      // stay in sync with the topbar dropdown.
      if (global.CryptNav) global.CryptNav.select(card.dataset.game);
    });

    container.querySelector('#lobbyCats').addEventListener('click', (e) => {
      const btn = e.target.closest('.lobby-cat');
      if (!btn) return;
      cat = btn.dataset.cat;
      container.querySelectorAll('.lobby-cat').forEach(b => b.classList.toggle('active', b === btn));
      render();
    });
    search.addEventListener('input', () => { query = search.value.trim(); render(); });

    render();
    return function () {};
  }

  global.Games = global.Games || {};
  global.Games.lobby = mount;
})(window);
