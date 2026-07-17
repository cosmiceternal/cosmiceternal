/* Single source of truth for the game list — display name, icon, category and
 * a one-word tag. Both the lobby grid and the topbar "All Games" dropdown read
 * from here, so a rename or a new game is a one-line change.
 *
 * IMPORTANT: `key` is the stable internal id (route + DB `game` column). Only
 * `name` is the display label — renaming a game never touches the backend. */
(function (global) {
  'use strict';

  const GAMES = [
    { key: 'crash',       name: 'Crash',          icon: '📈', cat: 'originals', tag: 'to 100×+' },
    { key: 'aidealer',    name: 'AI Dealer',      icon: '🎰', cat: 'cards',     tag: 'live banter' },
    { key: 'chicken',     name: 'Golden Crossing',icon: '🐔', cat: 'originals', tag: 'cash out' },
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
    { key: 'war',         name: 'Card Duel',      icon: '⚔️', cat: 'cards',     tag: 'instant' },
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
    { key: 'derby',       name: 'Derby',          icon: '🏇', cat: 'tables',    tag: 'live race' },
    { key: 'megawheel',   name: 'Mega Wheel',     icon: '🎡', cat: 'tables',    tag: 'money wheel' },
    { key: 'diamonds',    name: 'Diamonds',       icon: '💎', cat: 'originals', tag: 'match' },
    { key: 'slots',       name: 'Slots',          icon: '🍒', cat: 'slots',     tag: 'jackpot' },
    { key: 'luckysevens', name: 'Lucky Sevens',   icon: '7️⃣', cat: 'slots',     tag: 'jackpot' },
    { key: 'cosmic',      name: 'Cosmic Reels',   icon: '🌌', cat: 'slots',     tag: 'to 190×' },
    { key: 'neonfruits',  name: 'Neon Fruits',    icon: '🍒', cat: 'slots',     tag: '10 lines' },
    { key: 'sugarblast',  name: 'Sugar Blast',    icon: '🍬', cat: 'slots',     tag: 'tumble' },
    { key: 'coin',        name: 'Double Up',      icon: '🪙', cat: 'originals', tag: 'streak' },
    { key: 'scratch',     name: 'Instant Fortune',icon: '🎫', cat: 'originals', tag: 'instant' },
    { key: 'color',       name: 'Spectrum',       icon: '🎨', cat: 'originals', tag: 'predict' },
    { key: 'cashhunt',    name: 'Treasure Hunt',  icon: '🎁', cat: 'originals', tag: '25 tiles' },
    { key: 'bigcatch',    name: 'Golden Catch',   icon: '🎣', cat: 'originals', tag: '40× whale' },
    { key: 'rps',         name: 'Showdown',       icon: '✊', cat: 'originals', tag: 'vs house' },
    { key: 'tenpin',      name: 'Strike Zone',    icon: '🎳', cat: 'originals', tag: 'strike 10×' },
    { key: 'bullseye',    name: 'Sharpshooter',   icon: '🎯', cat: 'originals', tag: '3 darts' },
    { key: 'firecracker', name: 'Fortune Fuse',   icon: '🧨', cat: 'originals', tag: 'up to 100×' },
    { key: 'zeusgates',   name: "Zeus's Gates",   icon: '🏛️', cat: 'slots',     tag: 'pay anywhere' },
    { key: 'slingo',      name: 'Slingo',         icon: '🎰', cat: 'slots',     tag: 'slots + bingo' },
    { key: 'miniroulette',name: 'Mini Roulette',  icon: '🎡', cat: 'tables',    tag: '13 pockets' }
  ];

  const CATS = [
    { key: 'all',       label: 'All' },
    { key: 'favs',      label: '⭐ Favorites' },
    { key: 'originals', label: 'Originals' },
    { key: 'cards',     label: 'Cards' },
    { key: 'slots',     label: 'Slots' },
    { key: 'tables',    label: 'Tables & Dice' }
  ];
  // Dropdown groups (excludes the meta All/Favorites tabs).
  const GROUPS = [
    { key: 'originals', label: '🎯 Originals' },
    { key: 'cards',     label: '🃏 Cards' },
    { key: 'slots',     label: '🎰 Slots' },
    { key: 'tables',    label: '🎡 Tables & Dice' }
  ];

  const byKey = {};
  GAMES.forEach(g => { byKey[g.key] = g; });

  global.GameCatalog = { GAMES, CATS, GROUPS, byKey, nameOf: (k) => (byKey[k] ? byKey[k].name : k) };
})(window);
