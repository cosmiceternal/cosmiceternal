'use strict';

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ================================================================
//  In-memory cache
// ================================================================
const cache = new Map();
function getCache(key, ttlMs) {
  const e = cache.get(key);
  if (!e || Date.now() - e.ts > ttlMs) return null;
  return e.data;
}
function setCache(key, data) { cache.set(key, { data, ts: Date.now() }); }

// ================================================================
//  Yahoo Finance proxy (used when external APIs are reachable)
// ================================================================
let yfCrumb = null, yfCookies = '', yfCrumbTime = 0, yfAvailable = null;

async function ensureCrumb() {
  if (yfCrumb && Date.now() - yfCrumbTime < 3600_000) return true;
  try {
    const r1 = await fetch('https://fc.yahoo.com/', { redirect: 'manual', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(5000) });
    const raw = r1.headers.getSetCookie ? r1.headers.getSetCookie() : [];
    yfCookies = raw.map(c => c.split(';')[0]).join('; ');
    if (!yfCookies) {
      const sc = r1.headers.get('set-cookie') || '';
      yfCookies = sc.split(/,(?=[^ ])/).map(c => c.trim().split(';')[0]).join('; ');
    }
    const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': UA, Cookie: yfCookies }, signal: AbortSignal.timeout(5000)
    });
    if (r2.ok) { yfCrumb = await r2.text(); yfCrumbTime = Date.now(); return true; }
  } catch {}
  return false;
}

async function yfFetch(url) {
  if (yfAvailable === false) throw new Error('Yahoo Finance unavailable');
  const ok = await ensureCrumb();
  if (!ok) { yfAvailable = false; throw new Error('Yahoo Finance unavailable'); }
  const u = new URL(url);
  if (yfCrumb) u.searchParams.set('crumb', yfCrumb);
  const res = await fetch(u.toString(), {
    headers: { 'User-Agent': UA, Cookie: yfCookies },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) { yfCrumbTime = 0; yfAvailable = false; }
    throw new Error(`Yahoo ${res.status}`);
  }
  yfAvailable = true;
  return res.json();
}

// ================================================================
//  Market Simulation Engine — realistic fallback when APIs blocked
// ================================================================
const SIM_STOCKS = {
  AAPL:  { name:'Apple Inc.', sector:'Technology', base:212.50, mktCap:3.28e12, pe:33.2, eps:6.40, beta:1.24, divYield:0.0044, avgVol:54_200_000 },
  MSFT:  { name:'Microsoft Corporation', sector:'Technology', base:448.20, mktCap:3.33e12, pe:37.1, eps:12.08, beta:0.89, divYield:0.0069, avgVol:20_100_000 },
  GOOGL: { name:'Alphabet Inc.', sector:'Technology', base:178.30, mktCap:2.19e12, pe:23.8, eps:7.49, beta:1.06, divYield:0.0045, avgVol:24_500_000 },
  AMZN:  { name:'Amazon.com, Inc.', sector:'Cons. Disc.', base:201.80, mktCap:2.12e12, pe:38.4, eps:5.25, beta:1.15, divYield:0, avgVol:35_800_000 },
  NVDA:  { name:'NVIDIA Corporation', sector:'Technology', base:135.60, mktCap:3.34e12, pe:55.2, eps:2.46, beta:1.68, divYield:0.0003, avgVol:221_000_000 },
  META:  { name:'Meta Platforms, Inc.', sector:'Comm. Svcs', base:595.10, mktCap:1.51e12, pe:26.9, eps:22.12, beta:1.22, divYield:0.0034, avgVol:14_200_000 },
  TSLA:  { name:'Tesla, Inc.', sector:'Cons. Disc.', base:351.20, mktCap:1.13e12, pe:157, eps:2.24, beta:2.31, divYield:0, avgVol:82_100_000 },
  'BRK-B':{ name:'Berkshire Hathaway B', sector:'Financials', base:522.80, mktCap:1.08e12, pe:14.2, eps:36.80, beta:0.58, divYield:0, avgVol:3_400_000 },
  JPM:   { name:'JPMorgan Chase & Co.', sector:'Financials', base:268.40, mktCap:777e9, pe:13.1, eps:20.49, beta:1.11, divYield:0.0178, avgVol:8_200_000 },
  V:     { name:'Visa Inc.', sector:'Financials', base:316.90, mktCap:624e9, pe:31.5, eps:10.06, beta:0.93, divYield:0.0069, avgVol:5_800_000 },
  UNH:   { name:'UnitedHealth Group', sector:'Healthcare', base:324.50, mktCap:296e9, pe:14.8, eps:21.93, beta:0.62, divYield:0.022, avgVol:5_100_000 },
  WMT:   { name:'Walmart Inc.', sector:'Cons. Staples', base:96.50, mktCap:774e9, pe:38.2, eps:2.53, beta:0.51, divYield:0.0092, avgVol:13_400_000 },
  MA:    { name:'Mastercard Inc.', sector:'Financials', base:538.20, mktCap:494e9, pe:37.8, eps:14.24, beta:1.08, divYield:0.0049, avgVol:2_800_000 },
  PG:    { name:'Procter & Gamble', sector:'Cons. Staples', base:172.80, mktCap:406e9, pe:28.1, eps:6.15, beta:0.42, divYield:0.0236, avgVol:6_200_000 },
  HD:    { name:'Home Depot, Inc.', sector:'Cons. Disc.', base:375.60, mktCap:373e9, pe:24.6, eps:15.27, beta:1.04, divYield:0.0237, avgVol:3_400_000 },
  BAC:   { name:'Bank of America', sector:'Financials', base:47.80, mktCap:370e9, pe:14.3, eps:3.34, beta:1.38, divYield:0.022, avgVol:31_200_000 },
  COST:  { name:'Costco Wholesale', sector:'Cons. Staples', base:1006.20, mktCap:446e9, pe:56.4, eps:17.84, beta:0.79, divYield:0.0049, avgVol:1_800_000 },
  NFLX:  { name:'Netflix, Inc.', sector:'Comm. Svcs', base:1055.40, mktCap:453e9, pe:48.2, eps:21.90, beta:1.35, divYield:0, avgVol:3_100_000 },
  CRM:   { name:'Salesforce, Inc.', sector:'Technology', base:280.70, mktCap:271e9, pe:42.1, eps:6.67, beta:1.31, divYield:0.0054, avgVol:5_600_000 },
  PLTR:  { name:'Palantir Technologies', sector:'Technology', base:165.30, mktCap:388e9, pe:238, eps:0.69, beta:2.52, divYield:0, avgVol:52_400_000 },

  // ETFs
  SPY:  { name:'SPDR S&P 500 ETF', sector:'ETF', base:596.20, mktCap:0, pe:0, eps:0, beta:1.0, divYield:0.012, avgVol:68_000_000 },
  QQQ:  { name:'Invesco QQQ Trust', sector:'ETF', base:522.80, mktCap:0, pe:0, eps:0, beta:1.1, divYield:0.006, avgVol:32_000_000 },
  IWM:  { name:'iShares Russell 2000', sector:'ETF', base:226.40, mktCap:0, pe:0, eps:0, beta:1.2, divYield:0.011, avgVol:20_000_000 },
  DIA:  { name:'SPDR Dow Jones ETF', sector:'ETF', base:432.60, mktCap:0, pe:0, eps:0, beta:0.95, divYield:0.016, avgVol:3_200_000 },
  VTI:  { name:'Vanguard Total Stock', sector:'ETF', base:296.30, mktCap:0, pe:0, eps:0, beta:1.0, divYield:0.013, avgVol:3_400_000 },
  VOO:  { name:'Vanguard S&P 500', sector:'ETF', base:547.80, mktCap:0, pe:0, eps:0, beta:1.0, divYield:0.012, avgVol:4_100_000 },
  VEA:  { name:'Vanguard FTSE Dev Mkts', sector:'ETF', base:54.20, mktCap:0, pe:0, eps:0, beta:0.85, divYield:0.028, avgVol:8_200_000 },
  VWO:  { name:'Vanguard FTSE EM', sector:'ETF', base:47.60, mktCap:0, pe:0, eps:0, beta:0.9, divYield:0.025, avgVol:7_600_000 },
  BND:  { name:'Vanguard Total Bond', sector:'ETF', base:71.40, mktCap:0, pe:0, eps:0, beta:0.05, divYield:0.039, avgVol:5_800_000 },
  TLT:  { name:'iShares 20+ Yr Treasury', sector:'ETF', base:88.20, mktCap:0, pe:0, eps:0, beta:0.15, divYield:0.041, avgVol:19_000_000 },
  GLD:  { name:'SPDR Gold Shares', sector:'ETF', base:243.60, mktCap:0, pe:0, eps:0, beta:0.08, divYield:0, avgVol:7_200_000 },
  SLV:  { name:'iShares Silver Trust', sector:'ETF', base:29.80, mktCap:0, pe:0, eps:0, beta:0.3, divYield:0, avgVol:15_000_000 },
  ARKK: { name:'ARK Innovation ETF', sector:'ETF', base:58.30, mktCap:0, pe:0, eps:0, beta:1.8, divYield:0, avgVol:8_400_000 },
  SCHD: { name:'Schwab US Div Equity', sector:'ETF', base:86.40, mktCap:0, pe:0, eps:0, beta:0.82, divYield:0.034, avgVol:4_100_000 },
  VIG:  { name:'Vanguard Div Apprec', sector:'ETF', base:194.20, mktCap:0, pe:0, eps:0, beta:0.85, divYield:0.017, avgVol:1_200_000 },
  JEPI: { name:'JPMorgan Equity Prem', sector:'ETF', base:59.80, mktCap:0, pe:0, eps:0, beta:0.6, divYield:0.071, avgVol:2_800_000 },

  // Sector ETFs
  XLK:  { name:'Technology Select SPDR', sector:'ETF', base:236.40, mktCap:0, pe:0, eps:0, beta:1.15, divYield:0.006, avgVol:5_400_000 },
  XLV:  { name:'Health Care Select SPDR', sector:'ETF', base:148.60, mktCap:0, pe:0, eps:0, beta:0.75, divYield:0.014, avgVol:6_800_000 },
  XLF:  { name:'Financial Select SPDR', sector:'ETF', base:48.20, mktCap:0, pe:0, eps:0, beta:1.1, divYield:0.016, avgVol:28_000_000 },
  XLY:  { name:'Cons. Discr. Select SPDR', sector:'ETF', base:210.80, mktCap:0, pe:0, eps:0, beta:1.15, divYield:0.008, avgVol:3_200_000 },
  XLC:  { name:'Comm. Svcs Select SPDR', sector:'ETF', base:99.40, mktCap:0, pe:0, eps:0, beta:1.05, divYield:0.007, avgVol:4_600_000 },
  XLI:  { name:'Industrial Select SPDR', sector:'ETF', base:133.20, mktCap:0, pe:0, eps:0, beta:1.05, divYield:0.013, avgVol:8_200_000 },
  XLP:  { name:'Cons. Staples Select SPDR', sector:'ETF', base:82.40, mktCap:0, pe:0, eps:0, beta:0.55, divYield:0.024, avgVol:7_100_000 },
  XLE:  { name:'Energy Select SPDR', sector:'ETF', base:83.60, mktCap:0, pe:0, eps:0, beta:0.95, divYield:0.034, avgVol:14_200_000 },
  XLU:  { name:'Utilities Select SPDR', sector:'ETF', base:79.20, mktCap:0, pe:0, eps:0, beta:0.45, divYield:0.029, avgVol:9_800_000 },
  XLRE: { name:'Real Estate Select SPDR', sector:'ETF', base:43.80, mktCap:0, pe:0, eps:0, beta:0.85, divYield:0.032, avgVol:4_200_000 },
  XLB:  { name:'Materials Select SPDR', sector:'ETF', base:87.40, mktCap:0, pe:0, eps:0, beta:1.0, divYield:0.018, avgVol:4_600_000 },

  // Indices (simulated as quote-like objects)
  '^GSPC':  { name:'S&P 500', sector:'Index', base:5942.80, mktCap:0, pe:24.2, eps:245.6, beta:1.0, divYield:0.013, avgVol:0 },
  '^VIX':   { name:'CBOE Volatility Index', sector:'Index', base:14.20, mktCap:0, pe:0, eps:0, beta:-0.8, divYield:0, avgVol:0 },
  '^TNX':   { name:'10-Year Treasury Yield', sector:'Index', base:4.28, mktCap:0, pe:0, eps:0, beta:0.1, divYield:0, avgVol:0 },
  'DX-Y.NYB':{ name:'US Dollar Index', sector:'Index', base:104.20, mktCap:0, pe:0, eps:0, beta:0.05, divYield:0, avgVol:0 },
  'GC=F':   { name:'Gold Futures', sector:'Futures', base:2680.40, mktCap:0, pe:0, eps:0, beta:0.1, divYield:0, avgVol:185_000 },
  'CL=F':   { name:'Crude Oil WTI', sector:'Futures', base:71.20, mktCap:0, pe:0, eps:0, beta:0.4, divYield:0, avgVol:320_000 },
  'BTC-USD':{ name:'Bitcoin USD', sector:'Crypto', base:104800, mktCap:2.06e12, pe:0, eps:0, beta:1.8, divYield:0, avgVol:28_000_000_000 },

  // Futures
  'ES=F':  { name:'E-Mini S&P 500', sector:'Futures', base:5955, mktCap:0, pe:0, eps:0, beta:1.0, divYield:0, avgVol:1_200_000 },
  'NQ=F':  { name:'E-Mini Nasdaq 100', sector:'Futures', base:21380, mktCap:0, pe:0, eps:0, beta:1.15, divYield:0, avgVol:420_000 },
  'YM=F':  { name:'Mini Dow Jones', sector:'Futures', base:43650, mktCap:0, pe:0, eps:0, beta:0.95, divYield:0, avgVol:82_000 },
  'RTY=F': { name:'E-Mini Russell 2000', sector:'Futures', base:2262, mktCap:0, pe:0, eps:0, beta:1.2, divYield:0, avgVol:180_000 },
  'SI=F':  { name:'Silver Futures', sector:'Futures', base:31.40, mktCap:0, pe:0, eps:0, beta:0.3, divYield:0, avgVol:65_000 },
  'ZB=F':  { name:'T-Bond Futures', sector:'Futures', base:118.50, mktCap:0, pe:0, eps:0, beta:0.1, divYield:0, avgVol:240_000 },
  'ZN=F':  { name:'10-Year T-Note', sector:'Futures', base:110.20, mktCap:0, pe:0, eps:0, beta:0.08, divYield:0, avgVol:920_000 },
  '6E=F':  { name:'Euro FX Futures', sector:'Futures', base:1.0820, mktCap:0, pe:0, eps:0, beta:0.05, divYield:0, avgVol:210_000 },
  '6J=F':  { name:'Japanese Yen Futures', sector:'Futures', base:0.00648, mktCap:0, pe:0, eps:0, beta:0.04, divYield:0, avgVol:120_000 },
  '6B=F':  { name:'British Pound Futures', sector:'Futures', base:1.2680, mktCap:0, pe:0, eps:0, beta:0.05, divYield:0, avgVol:85_000 },
  'NG=F':  { name:'Natural Gas Futures', sector:'Futures', base:2.84, mktCap:0, pe:0, eps:0, beta:0.5, divYield:0, avgVol:280_000 },
  'HG=F':  { name:'Copper Futures', sector:'Futures', base:4.52, mktCap:0, pe:0, eps:0, beta:0.6, divYield:0, avgVol:54_000 },
  'KC=F':  { name:'Coffee Futures', sector:'Futures', base:262.40, mktCap:0, pe:0, eps:0, beta:0.3, divYield:0, avgVol:32_000 },

  // Forex
  'EURUSD=X': { name:'EUR/USD', sector:'Forex', base:1.0825, mktCap:0, pe:0, eps:0, beta:0.05, divYield:0, avgVol:0 },
  'GBPUSD=X': { name:'GBP/USD', sector:'Forex', base:1.2685, mktCap:0, pe:0, eps:0, beta:0.06, divYield:0, avgVol:0 },
  'USDJPY=X': { name:'USD/JPY', sector:'Forex', base:154.20, mktCap:0, pe:0, eps:0, beta:0.04, divYield:0, avgVol:0 },
  'USDCHF=X': { name:'USD/CHF', sector:'Forex', base:0.8842, mktCap:0, pe:0, eps:0, beta:0.04, divYield:0, avgVol:0 },
  'AUDUSD=X': { name:'AUD/USD', sector:'Forex', base:0.6520, mktCap:0, pe:0, eps:0, beta:0.06, divYield:0, avgVol:0 },
  'USDCAD=X': { name:'USD/CAD', sector:'Forex', base:1.3680, mktCap:0, pe:0, eps:0, beta:0.04, divYield:0, avgVol:0 },
  'NZDUSD=X': { name:'NZD/USD', sector:'Forex', base:0.5980, mktCap:0, pe:0, eps:0, beta:0.06, divYield:0, avgVol:0 },
  'EURGBP=X': { name:'EUR/GBP', sector:'Forex', base:0.8535, mktCap:0, pe:0, eps:0, beta:0.03, divYield:0, avgVol:0 },
  'EURJPY=X': { name:'EUR/JPY', sector:'Forex', base:166.90, mktCap:0, pe:0, eps:0, beta:0.05, divYield:0, avgVol:0 },
  'GBPJPY=X': { name:'GBP/JPY', sector:'Forex', base:195.60, mktCap:0, pe:0, eps:0, beta:0.06, divYield:0, avgVol:0 },
};

// Simulation state: per-symbol current price & daily open
const simState = {};
let marketSentiment = 0;

function initSim() {
  marketSentiment = (Math.random() - 0.5) * 0.008;
  for (const [sym, info] of Object.entries(SIM_STOCKS)) {
    const stockBias = (Math.random() - 0.5) * 0.02;
    const dailyMove = (stockBias + marketSentiment) * info.beta;
    const open = info.base * (1 + dailyMove * 0.3);
    const current = info.base * (1 + dailyMove);
    simState[sym] = {
      open: round(open, sym),
      prev: round(info.base, sym),
      current: round(current, sym),
      dayHigh: round(Math.max(open, current) * (1 + Math.random() * 0.006), sym),
      dayLow: round(Math.min(open, current) * (1 - Math.random() * 0.006), sym),
      volume: Math.floor(info.avgVol * (0.4 + Math.random() * 0.8)),
    };
  }
}

function round(val, sym) {
  if (sym && SIM_STOCKS[sym]) {
    const b = SIM_STOCKS[sym].base;
    if (b < 1) return Math.round(val * 100000) / 100000;
    if (b < 10) return Math.round(val * 10000) / 10000;
  }
  return Math.round(val * 100) / 100;
}

function tickSim() {
  marketSentiment += (Math.random() - 0.5) * 0.002;
  marketSentiment = Math.max(-0.03, Math.min(0.03, marketSentiment));

  for (const [sym, info] of Object.entries(SIM_STOCKS)) {
    const s = simState[sym];
    if (!s) continue;
    const vol = info.beta * 0.0004;
    const drift = marketSentiment * info.beta * 0.1;
    const shock = (Math.random() - 0.5) * 2 * vol;
    const revert = (info.base - s.current) / info.base * 0.001;
    s.current = round(s.current * (1 + drift + shock + revert), sym);
    s.dayHigh = round(Math.max(s.dayHigh, s.current), sym);
    s.dayLow = round(Math.min(s.dayLow, s.current), sym);
    s.volume += Math.floor(Math.random() * info.avgVol * 0.001);
  }
}

function buildQuote(sym) {
  const info = SIM_STOCKS[sym];
  const s = simState[sym];
  if (!info || !s) return null;

  const chg = s.current - s.prev;
  const chgPct = s.prev ? (chg / s.prev) * 100 : 0;
  const w52hi = round(info.base * 1.35, sym);
  const w52lo = round(info.base * 0.72, sym);

  return {
    symbol: sym,
    shortName: info.name.length > 24 ? info.name.substring(0, 22) + '...' : info.name,
    longName: info.name,
    regularMarketPrice: s.current,
    regularMarketChange: round(chg, sym),
    regularMarketChangePercent: Math.round(chgPct * 100) / 100,
    regularMarketVolume: s.volume,
    regularMarketDayHigh: s.dayHigh,
    regularMarketDayLow: s.dayLow,
    regularMarketOpen: s.open,
    regularMarketPreviousClose: s.prev,
    fiftyTwoWeekHigh: w52hi,
    fiftyTwoWeekLow: w52lo,
    marketCap: info.mktCap || undefined,
    trailingPE: info.pe || undefined,
    epsTrailingTwelveMonths: info.eps || undefined,
    dividendYield: info.divYield || undefined,
    beta: info.beta,
    averageDailyVolume3Month: info.avgVol,
    fiftyDayAverage: round(info.base * (1 + (Math.random() - 0.5) * 0.03), sym),
    marketState: 'REGULAR',
    quoteType: info.sector === 'Index' ? 'INDEX' : info.sector === 'ETF' ? 'ETF' : info.sector === 'Forex' ? 'CURRENCY' : info.sector === 'Futures' ? 'FUTURE' : info.sector === 'Crypto' ? 'CRYPTOCURRENCY' : 'EQUITY',
    _simulated: true,
  };
}

function buildChartData(sym, range) {
  const info = SIM_STOCKS[sym];
  const s = simState[sym];
  if (!info || !s) return null;

  const rangeConf = {
    '1d':  { points: 78, intervalSec: 300, label: '5m' },
    '5d':  { points: 40, intervalSec: 900, label: '15m' },
    '1mo': { points: 22, intervalSec: 86400, label: '1d' },
    '3mo': { points: 63, intervalSec: 86400, label: '1d' },
    '1y':  { points: 52, intervalSec: 604800, label: '1wk' },
    '5y':  { points: 60, intervalSec: 2592000, label: '1mo' },
  };
  const conf = rangeConf[range] || rangeConf['1d'];
  const now = Math.floor(Date.now() / 1000);

  const timestamps = [];
  const opens = [], highs = [], lows = [], closes = [], volumes = [];
  let price = info.base * (1 - conf.points * 0.0003 * info.beta);

  for (let i = 0; i < conf.points; i++) {
    timestamps.push(now - (conf.points - i) * conf.intervalSec);
    const drift = (s.current - price) / (conf.points - i) * 0.5;
    const vol = info.beta * 0.008;
    const move = drift + (Math.random() - 0.5) * vol * price;
    const open = round(price, sym);
    price += move;
    const close = round(price, sym);
    const high = round(Math.max(open, close) * (1 + Math.random() * 0.003), sym);
    const low = round(Math.min(open, close) * (1 - Math.random() * 0.003), sym);

    opens.push(open);
    closes.push(close);
    highs.push(high);
    lows.push(low);
    volumes.push(Math.floor(info.avgVol / conf.points * (0.5 + Math.random())));
  }

  return {
    timestamp: timestamps,
    indicators: { quote: [{ open: opens, high: highs, low: lows, close: closes, volume: volumes }] },
    meta: { symbol: sym, range, dataGranularity: conf.label, _simulated: true }
  };
}

const SIM_NEWS = [
  { title:'Federal Reserve Officials Signal Patience on Rate Cuts Amid Sticky Inflation', publisher:'Reuters', age:600 },
  { title:'Tech Stocks Rally as AI Spending Boosts Cloud Revenue Forecasts', publisher:'Bloomberg', age:1200 },
  { title:'S&P 500 Hits Fresh All-Time High on Broad-Based Buying', publisher:'CNBC', age:2400 },
  { title:'Treasury Yields Dip as Investors Weigh Economic Slowdown Signals', publisher:'Wall Street Journal', age:3600 },
  { title:'NVIDIA Earnings Beat Estimates; Data Center Revenue Surges 122%', publisher:'MarketWatch', age:4800 },
  { title:'Oil Prices Edge Higher on OPEC+ Production Cut Extension', publisher:'Reuters', age:6000 },
  { title:'Apple Announces New AI Features Coming to iPhone 17 Lineup', publisher:'Bloomberg', age:7800 },
  { title:'Goldman Sachs Raises Year-End S&P 500 Target to 6,500', publisher:'CNBC', age:9000 },
  { title:'Housing Starts Fall 3.2% in Latest Sign of Cooling Demand', publisher:'Associated Press', age:10800 },
  { title:'Bitcoin Surpasses $105,000 as Institutional Adoption Accelerates', publisher:'CoinDesk', age:12600 },
  { title:'European Markets Close Higher; ECB Rate Decision in Focus', publisher:'Financial Times', age:14400 },
  { title:'Microsoft Azure Revenue Grows 29%, Beating Analyst Expectations', publisher:'TechCrunch', age:16200 },
  { title:'Consumer Confidence Index Rises for Third Consecutive Month', publisher:'Reuters', age:18000 },
  { title:'Semiconductor Stocks Surge on Strong Demand for AI Chips', publisher:'Bloomberg', age:21600 },
  { title:'Meta Platforms Reports 22% Revenue Growth; Ad Business Thrives', publisher:'Wall Street Journal', age:25200 },
  { title:'Gold Futures Hit Record High Above $2,700 on Safe-Haven Demand', publisher:'MarketWatch', age:28800 },
  { title:'Palantir Stock Jumps 8% After Major Government Contract Win', publisher:'CNBC', age:32400 },
  { title:'Retail Sales Data Shows Resilient Consumer Spending in Q2', publisher:'Associated Press', age:36000 },
  { title:'Tesla Deliveries Exceed Expectations; Stock Rallies in After-Hours', publisher:'Reuters', age:43200 },
  { title:'JPMorgan CEO Warns of Geopolitical Risks Impacting Global Markets', publisher:'Bloomberg', age:50400 },
];

function buildNews() {
  const now = Math.floor(Date.now() / 1000);
  return SIM_NEWS.map(n => ({
    title: n.title,
    publisher: n.publisher,
    providerPublishTime: now - n.age,
    link: '#',
    _simulated: true,
  }));
}

// Start simulation
initSim();
setInterval(tickSim, 3000);

// ================================================================
//  API Routes — tries Yahoo Finance, falls back to simulation
// ================================================================

app.get('/api/quotes', async (req, res) => {
  const symbols = (req.query.symbols || '').split(',').filter(Boolean);
  if (!symbols.length) return res.json({ quotes: [], source: 'none' });

  // Try Yahoo Finance first
  if (yfAvailable !== false) {
    try {
      const key = `yf:quotes:${symbols.sort().join(',')}`;
      const cached = getCache(key, 12_000);
      if (cached) return res.json(cached);
      const data = await yfFetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}`);
      const result = { quotes: data.quoteResponse?.result || [], source: 'yahoo' };
      setCache(key, result);
      return res.json(result);
    } catch {}
  }

  // Fallback: simulation
  tickSim();
  const quotes = symbols.map(s => buildQuote(s)).filter(Boolean);
  res.json({ quotes, source: 'simulation' });
});

app.get('/api/chart', async (req, res) => {
  const { symbol, range = '1d', interval } = req.query;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  if (yfAvailable !== false) {
    try {
      const key = `yf:chart:${symbol}:${range}:${interval}`;
      const cached = getCache(key, range === '1d' ? 30_000 : 60_000);
      if (cached) return res.json(cached);
      const data = await yfFetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval || '5m'}&includePrePost=false`);
      const result = data.chart?.result?.[0] || null;
      if (result) { setCache(key, result); return res.json(result); }
    } catch {}
  }

  const chart = buildChartData(symbol, range);
  if (chart) return res.json(chart);
  res.status(404).json({ error: 'Unknown symbol' });
});

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').toUpperCase().trim();
  if (!q) return res.json({ quotes: [], news: [] });

  if (yfAvailable !== false) {
    try {
      const data = await yfFetch(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=5`);
      return res.json({ quotes: data.quotes || [], news: data.news || [] });
    } catch {}
  }

  const matches = Object.entries(SIM_STOCKS)
    .filter(([sym, info]) => sym.includes(q) || info.name.toUpperCase().includes(q))
    .slice(0, 10)
    .map(([sym, info]) => ({
      symbol: sym,
      shortname: info.name,
      quoteType: info.sector === 'Index' ? 'INDEX' : info.sector === 'ETF' ? 'ETF' : 'EQUITY',
      exchange: 'SIM'
    }));
  res.json({ quotes: matches, news: [] });
});

app.get('/api/news', async (req, res) => {
  if (yfAvailable !== false) {
    try {
      const data = await yfFetch(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(req.query.q || 'stock market')}&quotesCount=0&newsCount=20`);
      return res.json({ news: data.news || [], source: 'yahoo' });
    } catch {}
  }
  res.json({ news: buildNews(), source: 'simulation' });
});

app.get('/api/status', (req, res) => {
  res.json({ dataSource: yfAvailable === false ? 'simulation' : 'yahoo', uptime: process.uptime() });
});

// ================================================================
//  Static files
// ================================================================
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (r, fp) => { r.set('Cache-Control', fp.endsWith('.html') ? 'no-cache' : 'public, max-age=300'); }
}));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ================================================================
//  Start
// ================================================================
(async () => {
  await ensureCrumb().catch(() => {});
  if (yfAvailable === false) console.log('Yahoo Finance unavailable — using simulation engine');
  else console.log('Yahoo Finance connected');
  app.listen(PORT, () => console.log(`Godel Terminal running at http://localhost:${PORT}`));
})();
