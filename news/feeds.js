'use strict';

// Topic tree for the news reader.
//
// Each topic node has:
//   title:    Human-readable name shown in menus and headers.
//   feeds:    One or more public RSS/Atom feed URLs (no API key required).
//   keywords: (optional) If present, only headlines whose title/summary
//             mention one of these words are shown. This is how broad feeds
//             get narrowed down into a focused sub-topic.
//
// Feeds are deliberately chosen from outlets that publish open RSS feeds.
// If an outlet ever drops a feed, the reader just skips it and keeps going.

const POLITICS_FEEDS = [
  'https://feeds.npr.org/1014/rss.xml',            // NPR Politics
  'https://feeds.bbci.co.uk/news/politics/rss.xml', // BBC Politics
  'https://thehill.com/news/feed/',                 // The Hill
];

const WORLD_FEEDS = [
  'https://feeds.bbci.co.uk/news/world/rss.xml',    // BBC World
  'https://feeds.npr.org/1004/rss.xml',             // NPR World
];

const ECONOMY_FEEDS = [
  'https://feeds.npr.org/1017/rss.xml',             // NPR Economy
  'https://feeds.bbci.co.uk/news/business/rss.xml', // BBC Business
  'https://feeds.marketwatch.com/marketwatch/topstories/', // MarketWatch
];

const MARKETS_FEEDS = [
  'https://feeds.marketwatch.com/marketwatch/marketpulse/', // MarketWatch markets
  'https://feeds.bbci.co.uk/news/business/rss.xml',         // BBC Business
];

// The two top-level sections, each with drill-down sub-topics.
const SECTIONS = {
  politics: {
    title: 'Politics',
    children: {
      top: {
        title: 'Top Political News',
        feeds: POLITICS_FEEDS,
      },
      elections: {
        title: 'Elections & Campaigns',
        feeds: POLITICS_FEEDS,
        keywords: ['election', 'campaign', 'ballot', 'vote', 'voter',
          'primary', 'poll', 'candidate', 'caucus', 'midterm'],
      },
      congress: {
        title: 'Congress & Legislation',
        feeds: POLITICS_FEEDS,
        keywords: ['congress', 'senate', 'house', 'lawmaker', 'bill',
          'legislation', 'filibuster', 'speaker', 'capitol', 'representative'],
      },
      executive: {
        title: 'White House & Executive',
        feeds: POLITICS_FEEDS,
        keywords: ['president', 'white house', 'administration', 'executive',
          'cabinet', 'oval office', 'veto', 'secretary'],
      },
      courts: {
        title: 'Courts & Legal',
        feeds: POLITICS_FEEDS,
        keywords: ['court', 'supreme court', 'judge', 'ruling', 'lawsuit',
          'justice', 'trial', 'indictment', 'appeal', 'legal'],
      },
      world: {
        title: 'World Politics & Diplomacy',
        feeds: WORLD_FEEDS,
        keywords: ['diplomacy', 'summit', 'treaty', 'sanction', 'ambassador',
          'foreign', 'nato', 'un ', 'united nations', 'war', 'election',
          'minister', 'president', 'government', 'parliament'],
      },
    },
  },

  economics: {
    title: 'Economics',
    children: {
      top: {
        title: 'Top Economic News',
        feeds: ECONOMY_FEEDS,
      },
      markets: {
        title: 'Markets & Stocks',
        feeds: MARKETS_FEEDS,
        keywords: ['stock', 'market', 'dow', 'nasdaq', 's&p', 'shares',
          'index', 'wall street', 'rally', 'sell-off', 'selloff', 'equities',
          'bond', 'yield', 'investor'],
      },
      fed: {
        title: 'Federal Reserve & Inflation',
        feeds: ECONOMY_FEEDS,
        keywords: ['fed', 'federal reserve', 'inflation', 'interest rate',
          'rate cut', 'rate hike', 'powell', 'cpi', 'monetary', 'prices',
          'deflation'],
      },
      jobs: {
        title: 'Jobs & Labor',
        feeds: ECONOMY_FEEDS,
        keywords: ['job', 'jobs', 'unemployment', 'labor', 'hiring', 'layoff',
          'wage', 'wages', 'payroll', 'workers', 'strike', 'union'],
      },
      housing: {
        title: 'Housing & Real Estate',
        feeds: ECONOMY_FEEDS,
        keywords: ['housing', 'home', 'homes', 'mortgage', 'real estate',
          'rent', 'rents', 'property', 'construction', 'foreclosure'],
      },
      crypto: {
        title: 'Crypto & Fintech',
        feeds: ECONOMY_FEEDS.concat(MARKETS_FEEDS),
        keywords: ['crypto', 'bitcoin', 'ethereum', 'blockchain', 'token',
          'stablecoin', 'fintech', 'digital currency', 'coinbase'],
      },
      global: {
        title: 'Global Economy & Trade',
        feeds: ECONOMY_FEEDS,
        keywords: ['trade', 'tariff', 'export', 'import', 'global', 'china',
          'europe', 'opec', 'oil', 'supply chain', 'gdp', 'recession',
          'imf', 'world bank'],
      },
    },
  },

  // International stations. Foreign-language ones carry a `lang` code so the
  // server can translate their headlines to English (subtitles). `country`
  // is just a flag emoji shown on the tile.
  world: {
    title: 'World',
    children: {
      aljazeera: { title: 'Al Jazeera', country: '🌍', lang: 'en',
        feeds: ['https://www.aljazeera.com/xml/rss/all.xml'] },
      france24: { title: 'France 24', country: '🇫🇷', lang: 'fr',
        feeds: ['https://www.france24.com/fr/rss'] },
      lemonde: { title: 'Le Monde', country: '🇫🇷', lang: 'fr',
        feeds: ['https://www.lemonde.fr/rss/une.xml'] },
      dw: { title: 'DW (Deutschland)', country: '🇩🇪', lang: 'de',
        feeds: ['https://rss.dw.com/xml/rss-de-all'] },
      spiegel: { title: 'Der Spiegel', country: '🇩🇪', lang: 'de',
        feeds: ['https://www.spiegel.de/schlagzeilen/tops/index.rss'] },
      elpais: { title: 'El País', country: '🇪🇸', lang: 'es',
        feeds: ['https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada'] },
      ansa: { title: 'ANSA', country: '🇮🇹', lang: 'it',
        feeds: ['https://www.ansa.it/sito/ansait_rss.xml'] },
      nhk: { title: 'NHK', country: '🇯🇵', lang: 'ja',
        feeds: ['https://www3.nhk.or.jp/rss/news/cat0.xml'] },
      g1: { title: 'G1 Globo', country: '🇧🇷', lang: 'pt',
        feeds: ['https://g1.globo.com/dynamo/rss2.xml'] },
      toi: { title: 'Times of India', country: '🇮🇳', lang: 'en',
        feeds: ['https://timesofindia.indiatimes.com/rssfeedstopstories.cms'] },
    },
  },
};

module.exports = { SECTIONS };
