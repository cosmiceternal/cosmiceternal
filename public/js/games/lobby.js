/* Lobby — the casino floor. A searchable, filterable grid of every game
 * with star-to-favorite (persisted in localStorage). Mounts into the game
 * pane like any other game; clicking a card routes through the existing
 * tab-strip click handler so active-tab state and last-game memory stay
 * consistent. */
(function (global) {
  'use strict';

  // Single source of truth for lobby metadata. `cat` keys:
  //   originals | cards | slots | tables
  const GAMES = [
    { key: 'crash',       name: 'Crash',          icon: '📈', cat: 'originals', tag: 'to 100×+' },
    { key: 'aidealer',    name: 'AI Dealer',      icon: '🎰', cat: 'cards',     tag: 'live banter' },
    { key: 'chicken',     name: 'Chicken Road',   icon: '🐔', cat: 'originals', tag: 'cash out' },
    { key: 'mines',       name: 'Mines',          icon: '💣', cat: 'originals', tag: 'pick safe' },
    { key: 'towers',      name: 'Towers',         icon: '🏗️', cat: 'originals', tag: 'climb' },
    { key: 'pump',        name: 'Pump',           icon: '⛽', cat: 'originals', tag: 'push it' },
    { key: 'penalty',     name: 'Penalty',        icon: '⚽', cat: 'originals', tag: 'streak' },
    { key: 'cascade',     name: 'Cascade',        icon: '🔥', cat: 'originals', tag: 'chain' },
    { key: 'limbo',       name: 'Limbo',          icon: '🚀', cat: 'originals', tag: 'aim high' },
    { key: 'plinko',      name: 'Plinko',         icon: '🎯', cat: 'originals', tag: 'drop' },
    { key: 'pachinko',    name: 'Pachinko',       icon: '📍', cat: 'originals', tag: '4× edges' },
    { key: 'dice',        name: 'Dice',           icon: '🎲', cat: 'originals', tag: '99% RTP' },
    { key: 'hilo',        name: 'Hi-Lo',          icon: '↕️', cat: 'cards',     tag: 'streak' },
    { key: 'blackjack',   name: 'Blackjack',      icon: '🃏', cat: 'cards',     tag: '3:2' },
    { key: 'war',         name: 'War',            icon: '⚔️', cat: 'cards',     tag: 'instant' },
    { key: 'threecard',   name: 'Three Card',     icon: '🂡', cat: 'cards',     tag: 'vs dealer' },
    { key: 'videopoker',  name: 'Video Poker',    icon: '♠️', cat: 'cards',     tag: 'JoB' },
    { key: 'baccarat',    name: 'Baccarat',       icon: '🎴', cat: 'cards',     tag: 'classic' },
    { key: 'dragontiger', name: 'Dragon Tiger',   icon: '🐲', cat: 'cards',     tag: 'fast' },
    { key: 'andarbahar',  name: 'Andar Bahar',    icon: '🪷', cat: 'cards',     tag: 'classic' },
    { key: 'wheel',       name: 'Wheel',          icon: '🎡', cat: 'tables',    tag: '3 risks' },
    { key: 'roulette',    name: 'Roulette',       icon: '⚪', cat: 'tables',    tag: 'european' },
    { key: 'keno',        name: 'Keno',           icon: '🔢', cat: 'tables',    tag: 'pick 10' },
    { key: 'bingo',       name: 'Bingo Rush',     icon: '🎱', cat: 'tables',    tag: 'to 2500×' },
    { key: 'sicbo',       name: 'Sic Bo',         icon: '🎲', cat: 'tables',    tag: '3 dice' },
    { key: 'craps',       name: 'Craps',          icon: '🎯', cat: 'tables',    tag: 'pass line' },
    { key: 'diamonds',    name: 'Diamonds',       icon: '💎', cat: 'originals', tag: 'match' },
    { key: 'slots',       name: 'Slots',          icon: '🍒', cat: 'slots',     tag: 'jackpot' },
    { key: 'luckysevens', name: 'Lucky Sevens',   icon: '7️⃣', cat: 'slots',     tag: 'jackpot' },
    { key: 'cosmic',      name: 'Cosmic Reels',   icon: '🌌', cat: 'slots',     tag: 'to 190×' },
    { key: 'coin',        name: 'Coin Flip',      icon: '🪙', cat: 'originals', tag: 'double up' },
    { key: 'scratch',     name: 'Scratch',        icon: '🎫', cat: 'originals', tag: 'instant' },
    { key: 'color',       name: 'Color',          icon: '🎨', cat: 'originals', tag: 'predict' },
    { key: 'derby',       name: 'Derby',          icon: '🏇', cat: 'tables',    tag: 'live race' },
    { key: 'cashhunt',    name: 'Cash Hunt',      icon: '🎁', cat: 'originals', tag: '25 tiles' },
    { key: 'bigcatch',    name: 'Big Catch',      icon: '🎣', cat: 'originals', tag: '40× whale' },
    { key: 'rps',         name: 'RPS Duel',       icon: '✊', cat: 'originals', tag: 'vs house' },
    { key: 'neonfruits',  name: 'Neon Fruits',    icon: '🍒', cat: 'slots',     tag: '10 lines' }
  ];
  const CATS = [
    { key: 'all',       label: 'All' },
    { key: 'favs',      label: '⭐ Favorites' },
    { key: 'originals', label: 'Originals' },
    { key: 'cards',     label: 'Cards' },
    { key: 'slots',     label: 'Slots' },
    { key: 'tables',    label: 'Tables & Dice' }
  ];

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
      // Route through the real tab so active state + last-game memory update.
      const tab = document.querySelector(`.tab[data-game="${card.dataset.game}"]`);
      if (tab) { tab.scrollIntoView({ inline: 'center', block: 'nearest' }); tab.click(); }
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
