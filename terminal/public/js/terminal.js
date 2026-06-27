'use strict';

// ==================== Configuration ====================
const QUOTE_INTERVAL = 15_000;
const CHART_INTERVAL = 60_000;
const NEWS_INTERVAL  = 180_000;

const WATCHLISTS = {
  stocks: ['AAPL','MSFT','GOOGL','AMZN','NVDA','META','TSLA','BRK-B','JPM','V','UNH','WMT','MA','PG','HD','BAC','COST','NFLX','CRM','PLTR'],
  etfs: ['SPY','QQQ','IWM','DIA','VTI','VOO','VEA','VWO','BND','TLT','GLD','SLV','XLK','XLF','XLE','XLV','ARKK','SCHD','VIG','JEPI'],
  futures: ['ES=F','NQ=F','YM=F','RTY=F','CL=F','GC=F','SI=F','ZB=F','ZN=F','6E=F','6J=F','6B=F','NG=F','HG=F','KC=F'],
  forex: ['EURUSD=X','GBPUSD=X','USDJPY=X','USDCHF=X','AUDUSD=X','USDCAD=X','NZDUSD=X','EURGBP=X','EURJPY=X','GBPJPY=X'],
  crypto: ['BTC-USD','ETH-USD','SOL-USD','BNB-USD','XRP-USD','ADA-USD','DOGE-USD','AVAX-USD','DOT-USD','MATIC-USD']
};

const SECTOR_MAP = [
  { name:'Technology', etf:'XLK', weight:30 },
  { name:'Healthcare', etf:'XLV', weight:13 },
  { name:'Financials', etf:'XLF', weight:13 },
  { name:'Cons. Disc.', etf:'XLY', weight:10 },
  { name:'Comm. Svcs', etf:'XLC', weight:9 },
  { name:'Industrials', etf:'XLI', weight:8 },
  { name:'Cons. Staples', etf:'XLP', weight:6 },
  { name:'Energy', etf:'XLE', weight:4 },
  { name:'Utilities', etf:'XLU', weight:3 },
  { name:'Real Estate', etf:'XLRE', weight:2 },
  { name:'Materials', etf:'XLB', weight:2 }
];

const INDEX_SYMBOLS = [
  { symbol:'QQQ', name:'Invesco QQQ' },
  { symbol:'SPY', name:'SPDR S&P 500' },
  { symbol:'^GSPC', name:'S&P 500' },
  { symbol:'^VIX', name:'CBOE Volatility' },
  { symbol:'IWM', name:'Russell 2000' },
  { symbol:'^TNX', name:'10-Yr Treasury' },
  { symbol:'DX-Y.NYB', name:'US Dollar Index' },
  { symbol:'GC=F', name:'Gold Futures' },
  { symbol:'CL=F', name:'Crude Oil WTI' },
  { symbol:'BTC-USD', name:'Bitcoin' }
];

const RANGE_INTERVALS = {
  '1d':'5m', '5d':'15m', '1mo':'1d', '3mo':'1d', '1y':'1wk', '5y':'1mo'
};

// ==================== State ====================
const state = {
  activeList: 'stocks',
  selectedTicker: 'AAPL',
  chartRange: '1d',
  quotes: {},
  chartData: null,
  prevPrices: {},
  searchTimeout: null,
  dataSource: 'unknown',
  sortCol: null,
  sortDir: 1,
  sparkCache: {},
};

// ==================== API Layer ====================
async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

async function fetchQuotes(symbols) {
  if (!symbols.length) return [];
  const data = await api(`/api/quotes?symbols=${encodeURIComponent(symbols.join(','))}`);
  if (data.source) state.dataSource = data.source;
  return data.quotes || [];
}

async function fetchChart(symbol, range) {
  const interval = RANGE_INTERVALS[range] || '1d';
  return api(`/api/chart?symbol=${encodeURIComponent(symbol)}&range=${range}&interval=${interval}`);
}

async function fetchSearch(query) {
  return api(`/api/search?q=${encodeURIComponent(query)}`);
}

async function fetchNews() {
  return api('/api/news?q=stock+market+today');
}

// ==================== Formatting ====================
function fmt(n, decimals) {
  if (n == null || isNaN(n)) return '—';
  if (decimals === undefined) {
    if (Math.abs(n) < 1) decimals = 4;
    else if (Math.abs(n) < 10) decimals = 4;
    else decimals = 2;
  }
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtCompact(n) {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n/1e12).toFixed(2)+'T';
  if (abs >= 1e9)  return (n/1e9).toFixed(2)+'B';
  if (abs >= 1e6)  return (n/1e6).toFixed(2)+'M';
  if (abs >= 1e3)  return (n/1e3).toFixed(1)+'K';
  return n.toFixed(2);
}

function fmtVol(n) {
  if (n == null) return '—';
  if (n >= 1e9) return (n/1e9).toFixed(1)+'B';
  if (n >= 1e6) return (n/1e6).toFixed(1)+'M';
  if (n >= 1e3) return (n/1e3).toFixed(0)+'K';
  return String(n);
}

function fmtSign(n, dec) {
  if (n == null || isNaN(n)) return '—';
  if (dec === undefined) {
    if (Math.abs(n) < 1) dec = 4;
    else dec = 2;
  }
  return (n >= 0 ? '+' : '') + fmt(n, dec);
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

function timeAgo(ts) {
  const diff = Math.floor(Date.now() / 1000 - ts);
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff/60)+'m ago';
  if (diff < 86400) return Math.floor(diff/3600)+'h ago';
  return Math.floor(diff/86400)+'d ago';
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ==================== Clock ====================
function updateClock() {
  const now = new Date();
  const et = now.toLocaleString('en-US', { timeZone:'America/New_York', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
  const utc = now.toLocaleString('en-US', { timeZone:'UTC', hour:'2-digit', minute:'2-digit', hour12:false });
  document.getElementById('clock').textContent = `ET ${et}  UTC ${utc}`;
}

function isMarketOpen() {
  const now = new Date();
  const etStr = now.toLocaleString('en-US', { timeZone:'America/New_York' });
  const et = new Date(etStr);
  const day = et.getDay();
  const mins = et.getHours() * 60 + et.getMinutes();
  if (day === 0 || day === 6) return 'closed';
  if (mins >= 570 && mins < 960) return 'open';
  if (mins >= 240 && mins < 570) return 'pre';
  if (mins >= 960 && mins < 1200) return 'post';
  return 'closed';
}

// ==================== Panel: Watchlist ====================
function getSortedSymbols() {
  const symbols = [...(WATCHLISTS[state.activeList] || [])];
  if (!state.sortCol) return symbols;

  const val = (sym) => {
    const q = state.quotes[sym];
    if (!q) return -Infinity;
    switch (state.sortCol) {
      case 'tk': return sym;
      case 'nm': return (q.shortName || q.longName || '').toLowerCase();
      case 'last': return q.regularMarketPrice ?? 0;
      case 'chg': return q.regularMarketChange ?? 0;
      case 'pct': return q.regularMarketChangePercent ?? 0;
      case 'vol': return q.regularMarketVolume ?? 0;
      case 'hi': return q.regularMarketDayHigh ?? 0;
      case 'lo': return q.regularMarketDayLow ?? 0;
      default: return 0;
    }
  };

  symbols.sort((a, b) => {
    const va = val(a), vb = val(b);
    if (typeof va === 'string') return va.localeCompare(vb) * state.sortDir;
    return (va - vb) * state.sortDir;
  });
  return symbols;
}

function renderWatchlist() {
  const symbols = getSortedSymbols();
  const body = document.getElementById('watchBody');
  const rows = [];

  for (const sym of symbols) {
    const q = state.quotes[sym];
    if (!q) {
      rows.push(`<div class="wl-row" data-sym="${sym}"><span class="wc wc-tk">${sym}</span><span class="wc wc-nm loading-shimmer">&nbsp;</span><span class="wc wc-last">—</span><span class="wc wc-chg">—</span><span class="wc wc-pct">—</span><span class="wc wc-vol">—</span><span class="wc wc-hi">—</span><span class="wc wc-lo">—</span></div>`);
      continue;
    }

    const price = q.regularMarketPrice ?? 0;
    const chg = q.regularMarketChange ?? 0;
    const pct = q.regularMarketChangePercent ?? 0;
    const vol = q.regularMarketVolume;
    const hi = q.regularMarketDayHigh;
    const lo = q.regularMarketDayLow;
    const name = (q.shortName || q.longName || '').substring(0, 18);
    const dir = chg >= 0 ? 'up' : 'down';

    const prevPrice = state.prevPrices[sym];
    let flash = '';
    if (prevPrice != null && Math.abs(prevPrice - price) > 0.001) {
      flash = price > prevPrice ? ' flash-green' : ' flash-red';
    }
    const sel = sym === state.selectedTicker ? ' selected' : '';

    rows.push(
      `<div class="wl-row ${dir}${sel}${flash}" data-sym="${sym}">` +
      `<span class="wc wc-tk">${sym}</span>` +
      `<span class="wc wc-nm">${escHtml(name)}</span>` +
      `<span class="wc wc-last">${fmt(price)}</span>` +
      `<span class="wc wc-chg">${fmtSign(chg)}</span>` +
      `<span class="wc wc-pct">${fmtPct(pct)}</span>` +
      `<span class="wc wc-vol">${fmtVol(vol)}</span>` +
      `<span class="wc wc-hi">${fmt(hi)}</span>` +
      `<span class="wc wc-lo">${fmt(lo)}</span>` +
      `</div>`
    );
    state.prevPrices[sym] = price;
  }

  body.innerHTML = rows.join('');
  updateSortIndicators();
}

function updateSortIndicators() {
  document.querySelectorAll('.wl-hdr .wc').forEach(el => {
    el.classList.remove('sort-asc', 'sort-desc');
    const col = (el.className.match(/wc-(\w+)/) || [])[1];
    if (col === state.sortCol) {
      el.classList.add(state.sortDir === 1 ? 'sort-asc' : 'sort-desc');
    }
  });
}

// ==================== Panel: News ====================
async function loadNews() {
  try {
    const data = await fetchNews();
    renderNews(data.news || []);
  } catch {
    document.getElementById('newsBody').innerHTML = '<div class="news-loading">Unable to load news</div>';
  }
}

function renderNews(items) {
  const body = document.getElementById('newsBody');
  if (!items.length) { body.innerHTML = '<div class="news-loading">No headlines</div>'; return; }

  body.innerHTML = items.map(n => {
    const time = n.providerPublishTime ? timeAgo(n.providerPublishTime) : '';
    return `<div class="news-item"><div class="news-title">${escHtml(n.title || '')}</div><div class="news-meta"><span class="news-pub">${escHtml(n.publisher || '')}</span><span class="news-time">${time}</span></div></div>`;
  }).join('');

  document.getElementById('newsTs').textContent = new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
}

// ==================== Panel: Heatmap ====================
function renderHeatmap() {
  const body = document.getElementById('heatBody');
  const W = body.clientWidth - 6;
  const H = body.clientHeight - 6;
  if (W < 20 || H < 20) return;

  const items = SECTOR_MAP.map(sec => {
    const q = state.quotes[sec.etf];
    const pct = q?.regularMarketChangePercent ?? 0;
    return { ...sec, pct, area: sec.weight };
  });

  const rects = squarify(items, { x: 0, y: 0, w: W, h: H });

  body.innerHTML = rects.map((r, i) => {
    const sec = items[i];
    const bg = heatColor(sec.pct);
    return `<div class="heat-cell" style="position:absolute;left:${r.x+3}px;top:${r.y+3}px;width:${r.w-2}px;height:${r.h-2}px;background:${bg}" data-sym="${sec.etf}"><span class="hc-name">${sec.name}</span><span class="hc-pct">${fmtPct(sec.pct)}</span><span class="hc-etf">${sec.etf}</span></div>`;
  }).join('');
}

function squarify(items, rect) {
  const total = items.reduce((s, i) => s + i.area, 0);
  const areas = items.map(i => (i.area / total) * rect.w * rect.h);
  const rects = [];
  let remaining = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  let idx = 0;

  while (idx < areas.length) {
    const isWide = remaining.w >= remaining.h;
    const side = isWide ? remaining.h : remaining.w;
    let row = [areas[idx]];
    let rowSum = areas[idx];
    idx++;

    while (idx < areas.length) {
      const test = [...row, areas[idx]];
      const testSum = rowSum + areas[idx];
      if (worstRatio(test, testSum, side) <= worstRatio(row, rowSum, side)) {
        row.push(areas[idx]);
        rowSum = testSum;
        idx++;
      } else break;
    }

    let offset = 0;
    const span = rowSum / side;
    for (const a of row) {
      const len = a / span;
      if (isWide) {
        rects.push({ x: remaining.x, y: remaining.y + offset, w: span, h: len });
      } else {
        rects.push({ x: remaining.x + offset, y: remaining.y, w: len, h: span });
      }
      offset += len;
    }

    if (isWide) {
      remaining = { x: remaining.x + span, y: remaining.y, w: remaining.w - span, h: remaining.h };
    } else {
      remaining = { x: remaining.x, y: remaining.y + span, w: remaining.w, h: remaining.h - span };
    }
  }
  return rects;
}

function worstRatio(row, sum, side) {
  const s2 = side * side;
  let worst = 0;
  for (const a of row) {
    const r = Math.max((s2 * a) / (sum * sum), (sum * sum) / (s2 * a));
    if (r > worst) worst = r;
  }
  return worst;
}

function heatColor(pct) {
  const t = Math.max(0, Math.min(1, (pct + 3) / 6));
  if (t < 0.45) {
    const f = t / 0.45;
    const r = Math.round(200 - f * 90);
    const g = Math.round(35 + f * 25);
    const b = Math.round(35 + f * 15);
    return `rgb(${r},${g},${b})`;
  }
  if (t < 0.55) {
    return 'rgb(60,55,55)';
  }
  const f = (t - 0.55) / 0.45;
  const r = Math.round(50 - f * 30);
  const g = Math.round(75 + f * 130);
  const b = Math.round(50 - f * 10);
  return `rgb(${r},${g},${b})`;
}

// ==================== Panel: Chart ====================
async function loadChart() {
  try {
    state.chartData = await fetchChart(state.selectedTicker, state.chartRange);
    renderChart();
  } catch (e) {
    document.getElementById('chartInfo').innerHTML = `<span style="color:var(--red)">Chart data unavailable</span>`;
  }
}

function renderChart() {
  const d = state.chartData;
  if (!d || !d.timestamp) return;
  const quote = d.indicators?.quote?.[0];
  if (!quote) return;

  const { close: closes, open: opens, high: highs, low: lows, volume: volumes } = quote;
  const valid = closes.filter(v => v != null);
  if (!valid.length) return;

  const last = valid[valid.length - 1];
  const first = valid[0];
  const chg = last - first;
  const pct = first ? (chg / first) * 100 : 0;
  const dir = chg >= 0 ? 'up' : 'down';

  document.getElementById('chartTicker').textContent = state.selectedTicker;
  document.getElementById('chartInfo').innerHTML =
    `<span class="ci-price">${fmt(last)}</span>` +
    `<span class="ci-chg ${dir}">${fmtSign(chg)} (${fmtPct(pct)})</span>` +
    `<span class="ci-range">${state.chartRange.toUpperCase()}</span>`;

  drawMainChart(d.timestamp, opens, highs, lows, closes);
  drawVolumeChart(opens, closes, volumes);
}

function setupCanvas(canvas, w, h) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return ctx;
}

function drawMainChart(timestamps, opens, highs, lows, closes) {
  const canvas = document.getElementById('mainChart');
  const parent = canvas.parentElement;
  const W = parent.clientWidth;
  const H = parent.clientHeight - 90;
  if (W < 50 || H < 50) return;

  const ctx = setupCanvas(canvas, W, H);
  ctx.clearRect(0, 0, W, H);

  const pad = { top: 6, right: 48, bottom: 18, left: 6 };
  const cW = W - pad.left - pad.right;
  const cH = H - pad.top - pad.bottom;

  const data = [];
  for (let i = 0; i < closes.length; i++) {
    if (closes[i] != null) data.push({ t: timestamps[i], o: opens[i]||closes[i], h: highs[i]||closes[i], l: lows[i]||closes[i], c: closes[i], idx: i });
  }
  if (data.length < 2) return;

  const allV = data.flatMap(d => [d.h, d.l]);
  let minV = Math.min(...allV), maxV = Math.max(...allV);
  const r = maxV - minV || 1;
  minV -= r * 0.04; maxV += r * 0.04;

  const xOf = i => pad.left + (i / (data.length - 1)) * cW;
  const yOf = v => pad.top + (1 - (v - minV) / (maxV - minV)) * cH;

  // Grid
  ctx.strokeStyle = 'rgba(40,40,60,0.5)';
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 5; i++) {
    const gy = pad.top + (i / 5) * cH;
    ctx.beginPath(); ctx.moveTo(pad.left, gy); ctx.lineTo(W - pad.right, gy); ctx.stroke();
    ctx.fillStyle = '#5a5a70'; ctx.font = '9px monospace'; ctx.textAlign = 'left';
    ctx.fillText(fmt(maxV - (i / 5) * (maxV - minV)), W - pad.right + 3, gy + 3);
  }

  const isUp = data[data.length - 1].c >= data[0].c;
  const useCandles = data.length <= 120;

  if (useCandles) {
    const bw = Math.max(1, cW / data.length * 0.55);
    for (let i = 0; i < data.length; i++) {
      const d = data[i], cx = xOf(i), bull = d.c >= d.o;
      const color = bull ? '#00c853' : '#e53935';
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, yOf(d.h)); ctx.lineTo(cx, yOf(d.l)); ctx.stroke();
      const top = yOf(Math.max(d.o, d.c)), bot = yOf(Math.min(d.o, d.c));
      ctx.fillRect(cx - bw / 2, top, bw, Math.max(bot - top, 1));
    }
  } else {
    const col = isUp ? '#00c853' : '#e53935';
    ctx.beginPath(); ctx.moveTo(xOf(0), yOf(data[0].c));
    for (let i = 1; i < data.length; i++) ctx.lineTo(xOf(i), yOf(data[i].c));
    ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.lineTo(xOf(data.length - 1), pad.top + cH);
    ctx.lineTo(xOf(0), pad.top + cH);
    ctx.closePath();
    ctx.fillStyle = isUp ? 'rgba(0,200,83,0.07)' : 'rgba(229,57,53,0.07)';
    ctx.fill();
  }

  // SMA20 overlay
  if (data.length >= 20) {
    ctx.beginPath();
    let started = false;
    for (let i = 19; i < data.length; i++) {
      let sum = 0;
      for (let j = i - 19; j <= i; j++) sum += data[j].c;
      const sma = sum / 20;
      const px = xOf(i), py = yOf(sma);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = 'rgba(255,171,0,0.5)'; ctx.lineWidth = 1; ctx.setLineDash([3,3]); ctx.stroke(); ctx.setLineDash([]);
  }

  // Time labels
  ctx.fillStyle = '#5a5a70'; ctx.font = '9px monospace'; ctx.textAlign = 'center';
  const lc = Math.min(6, data.length);
  for (let i = 0; i < lc; i++) {
    const idx = Math.floor(i / (lc - 1) * (data.length - 1));
    const d = new Date(data[idx].t * 1000);
    const intraday = state.chartRange === '1d' || state.chartRange === '5d';
    const label = intraday
      ? d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'America/New_York'})
      : d.toLocaleDateString('en-US',{month:'short',day:'numeric'});
    ctx.fillText(label, xOf(idx), H - 2);
  }

  // Crosshair overlay — positioned to exactly cover the main chart canvas
  let crosshairCanvas = canvas.parentElement.querySelector('.crosshair-canvas');
  if (!crosshairCanvas) {
    crosshairCanvas = document.createElement('canvas');
    crosshairCanvas.className = 'crosshair-canvas';
    canvas.parentElement.appendChild(crosshairCanvas);
  }
  crosshairCanvas.style.cssText =
    `position:absolute;top:${canvas.offsetTop}px;left:${canvas.offsetLeft}px;pointer-events:none;`;

  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (mx < pad.left || mx > W - pad.right) { clearCrosshair(crosshairCanvas); return; }
    const i = Math.round((mx - pad.left) / cW * (data.length - 1));
    if (i < 0 || i >= data.length) return;
    const d = data[i];

    const cCtx = setupCanvas(crosshairCanvas, W, H);
    cCtx.clearRect(0, 0, W, H);

    cCtx.setLineDash([3, 3]);
    cCtx.strokeStyle = 'rgba(255,255,255,0.2)';
    cCtx.lineWidth = 0.5;
    const cx = xOf(i), cy = yOf(d.c);
    cCtx.beginPath(); cCtx.moveTo(cx, pad.top); cCtx.lineTo(cx, pad.top + cH); cCtx.stroke();
    cCtx.beginPath(); cCtx.moveTo(pad.left, cy); cCtx.lineTo(W - pad.right, cy); cCtx.stroke();
    cCtx.setLineDash([]);

    cCtx.fillStyle = '#1c1c28';
    cCtx.fillRect(W - pad.right, cy - 8, pad.right, 16);
    cCtx.fillStyle = '#d4d4d8';
    cCtx.font = '9px monospace';
    cCtx.textAlign = 'left';
    cCtx.fillText(fmt(d.c), W - pad.right + 3, cy + 3);

    cCtx.beginPath();
    cCtx.arc(cx, cy, 3, 0, Math.PI * 2);
    cCtx.fillStyle = d.c >= data[0].c ? '#00c853' : '#e53935';
    cCtx.fill();

    const info = document.getElementById('chartInfo');
    const pchg = d.c - data[0].c;
    const ppct = data[0].c ? (pchg / data[0].c) * 100 : 0;
    const dr = pchg >= 0 ? 'up' : 'down';
    info.innerHTML =
      `<span class="ci-price">${fmt(d.c)}</span>` +
      `<span class="ci-chg ${dr}">O:${fmt(d.o)} H:${fmt(d.h)} L:${fmt(d.l)} C:${fmt(d.c)}</span>` +
      `<span class="ci-range">${fmtPct(ppct)}</span>`;
  };
  canvas.onmouseleave = () => { clearCrosshair(crosshairCanvas); renderChart(); };
}

function clearCrosshair(c) {
  if (!c) return;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
}

function drawVolumeChart(opens, closes, volumes) {
  const canvas = document.getElementById('volChart');
  const parent = canvas.parentElement;
  const W = parent.clientWidth;
  const H = 50;
  if (W < 50) return;

  const ctx = setupCanvas(canvas, W, H);
  ctx.clearRect(0, 0, W, H);

  const pad = { left: 6, right: 48 };
  const cW = W - pad.left - pad.right;

  const valid = [];
  for (let i = 0; i < volumes.length; i++) {
    if (volumes[i] != null) valid.push({ v: volumes[i], up: (closes[i]||0) >= (opens[i]||0), i });
  }
  if (!valid.length) return;

  const maxV = Math.max(...valid.map(d => d.v)) || 1;
  const bw = Math.max(1, cW / volumes.length * 0.6);

  for (const d of valid) {
    const x = pad.left + (d.i / (volumes.length - 1 || 1)) * cW;
    const bh = (d.v / maxV) * (H - 4);
    ctx.fillStyle = d.up ? 'rgba(0,200,83,0.3)' : 'rgba(229,57,53,0.3)';
    ctx.fillRect(x - bw / 2, H - bh, bw, bh);
  }
}

// ==================== Panel: Detail ====================
function renderDetail() {
  const q = state.quotes[state.selectedTicker];
  if (!q) {
    document.getElementById('detailName').textContent = 'Company Detail';
    document.getElementById('detailQuote').innerHTML = '<span class="no-data">Select a ticker</span>';
    document.getElementById('detailStats').innerHTML = '';
    return;
  }

  document.getElementById('detailName').textContent = q.longName || q.shortName || state.selectedTicker;

  const price = q.regularMarketPrice ?? 0;
  const chg = q.regularMarketChange ?? 0;
  const pct = q.regularMarketChangePercent ?? 0;
  const dir = chg >= 0 ? 'up' : 'down';

  document.getElementById('detailQuote').innerHTML =
    `<span class="dq-price">${fmt(price)}</span>` +
    `<span class="dq-chg ${dir}">${fmtSign(chg)} (${fmtPct(pct)})</span>` +
    `<span class="dq-mkt">${q.marketState || ''}</span>`;

  renderRangeBars(q, price);
  loadProfile(state.selectedTicker);
  drawDetailMiniChart();

  const stats = [
    ['Open', fmt(q.regularMarketOpen)],
    ['Prev Close', fmt(q.regularMarketPreviousClose)],
    ['Day High', fmt(q.regularMarketDayHigh)],
    ['Day Low', fmt(q.regularMarketDayLow)],
    ['52w High', fmt(q.fiftyTwoWeekHigh)],
    ['52w Low', fmt(q.fiftyTwoWeekLow)],
    ['Volume', fmtVol(q.regularMarketVolume)],
    ['Avg Vol', fmtVol(q.averageDailyVolume3Month)],
    ['Mkt Cap', q.marketCap ? fmtCompact(q.marketCap) : '—'],
    ['P/E', q.trailingPE ? fmt(q.trailingPE) : '—'],
    ['EPS', q.epsTrailingTwelveMonths ? fmt(q.epsTrailingTwelveMonths) : '—'],
    ['Div Yield', q.dividendYield ? (q.dividendYield * 100).toFixed(2)+'%' : '—'],
    ['Beta', q.beta ? fmt(q.beta) : '—'],
    ['50d Avg', fmt(q.fiftyDayAverage)],
  ];

  document.getElementById('detailStats').innerHTML = stats.map(([l, v]) =>
    `<div class="ds-row"><span class="ds-label">${l}</span><span class="ds-val">${v}</span></div>`
  ).join('');
}

function drawDetailMiniChart() {
  const canvas = document.getElementById('detailChart');
  const d = state.chartData;
  if (!d?.timestamp) return;

  const closes = (d.indicators?.quote?.[0]?.close || []).filter(v => v != null);
  if (closes.length < 2) return;

  const parent = canvas.parentElement;
  const W = parent.clientWidth - 20;
  const H = 120;
  const ctx = setupCanvas(canvas, W, H);
  ctx.clearRect(0, 0, W, H);

  const minV = Math.min(...closes), maxV = Math.max(...closes);
  const range = maxV - minV || 1;
  const isUp = closes[closes.length - 1] >= closes[0];
  const col = isUp ? '#00c853' : '#e53935';
  const pad = 4;

  ctx.beginPath();
  for (let i = 0; i < closes.length; i++) {
    const x = pad + (i / (closes.length - 1)) * (W - pad * 2);
    const y = pad + (1 - (closes[i] - minV) / range) * (H - pad * 2);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.stroke();

  ctx.lineTo(pad + (W - pad * 2), H - pad);
  ctx.lineTo(pad, H - pad);
  ctx.closePath();
  ctx.fillStyle = isUp ? 'rgba(0,200,83,0.05)' : 'rgba(229,57,53,0.05)';
  ctx.fill();
}

function renderRangeBars(q, price) {
  const el = document.getElementById('detailRange');
  const bar = (label, lo, hi, val) => {
    if (lo == null || hi == null || hi <= lo) return '';
    const pos = Math.max(0, Math.min(100, ((val - lo) / (hi - lo)) * 100));
    const col = pos >= 50 ? 'var(--green)' : 'var(--red)';
    return `<div class="dr-row"><span class="dr-label">${label}</span><span class="dr-lo">${fmt(lo)}</span><div class="dr-track"><div class="dr-fill" style="width:${pos}%;background:${col};opacity:.35"></div><div class="dr-marker" style="left:calc(${pos}% - 1px)"></div></div><span class="dr-hi">${fmt(hi)}</span></div>`;
  };
  el.innerHTML =
    bar('Day', q.regularMarketDayLow, q.regularMarketDayHigh, price) +
    bar('52wk', q.fiftyTwoWeekLow, q.fiftyTwoWeekHigh, price);
}

const profileCache = {};
async function loadProfile(sym) {
  const el = document.getElementById('detailDesc');
  if (profileCache[sym] !== undefined) { el.textContent = profileCache[sym]; return; }
  el.textContent = '';
  try {
    const data = await api(`/api/profile?symbol=${encodeURIComponent(sym)}`);
    profileCache[sym] = data.description || '';
    if (state.selectedTicker === sym) el.textContent = profileCache[sym];
  } catch { profileCache[sym] = ''; }
}

function updateSourceBadge() {
  const src = state.dataSource || 'unknown';
  const badge = document.getElementById('dataSource');
  const dot = document.getElementById('connDot');
  const isSim = src === 'simulation';
  const label = { yahoo:'Yahoo', twelvedata:'Twelve Data', finnhub:'Finnhub', simulation:'Simulated' }[src] || src;
  badge.textContent = label;
  badge.className = 't-source ' + (isSim ? 'sim' : src === 'unknown' ? '' : 'live');
  badge.title = isSim ? 'Simulated data — no live provider reachable. See README to enable real data.' : `Live market data via ${label}`;
  dot.className = 't-dot ' + (isSim ? 'sim' : '');
}

// ==================== Sparklines ====================
// Builds a rolling price history per symbol from polled quotes and
// renders a tiny inline SVG. Seeded from the day's open→price so a
// trend shows immediately, then refined live as quotes arrive.
function pushSparkPoint(sym, price) {
  if (price == null || isNaN(price)) return;
  let hist = state.sparkCache[sym];
  if (!hist) {
    const q = state.quotes[sym];
    const open = q?.regularMarketOpen ?? q?.regularMarketPreviousClose ?? price;
    hist = state.sparkCache[sym] = [open];
  }
  if (hist[hist.length - 1] !== price) hist.push(price);
  if (hist.length > 40) hist.shift();
}

function sparkline(sym, dir) {
  const hist = state.sparkCache[sym];
  if (!hist || hist.length < 2) return '<div class="idx-spark"></div>';
  const W = 56, H = 28, pad = 2;
  const min = Math.min(...hist), max = Math.max(...hist);
  const range = max - min || 1;
  const col = dir === 'up' ? 'var(--green)' : 'var(--red)';
  const pts = hist.map((v, i) => {
    const x = pad + (i / (hist.length - 1)) * (W - pad * 2);
    const y = pad + (1 - (v - min) / range) * (H - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const lastX = pad + (W - pad * 2);
  const lastY = pad + (1 - (hist[hist.length - 1] - min) / range) * (H - pad * 2);
  return `<svg class="idx-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
    `<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.2" stroke-linejoin="round"/>` +
    `<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="1.6" fill="${col}"/></svg>`;
}

// ==================== Panel: Indices ====================
function renderIndices() {
  const body = document.getElementById('idxBody');
  body.innerHTML = INDEX_SYMBOLS.map(idx => {
    const q = state.quotes[idx.symbol];
    if (!q) return `<div class="idx-card" data-sym="${idx.symbol}"><div class="idx-main"><div class="idx-top"><span class="idx-sym">${idx.symbol.replace('^','')}</span><span class="idx-price">—</span></div><div class="idx-bot"><span class="idx-name">${idx.name}</span><span class="idx-chg">—</span></div></div></div>`;

    const price = q.regularMarketPrice ?? 0;
    const chg = q.regularMarketChange ?? 0;
    const pct = q.regularMarketChangePercent ?? 0;
    const dir = chg >= 0 ? 'up' : 'down';
    const sym = idx.symbol.replace('^','').replace('=F','').replace('-USD','');
    const spark = sparkline(idx.symbol, dir);

    return `<div class="idx-card ${dir}" data-sym="${idx.symbol}"><div class="idx-main"><div class="idx-top"><span class="idx-sym">${sym}</span><span class="idx-price">${fmt(price)}</span></div><div class="idx-bot"><span class="idx-name">${idx.name}</span><span class="idx-chg">${fmtSign(chg)} (${fmtPct(pct)})</span></div></div>${spark}</div>`;
  }).join('');

  const mkt = isMarketOpen();
  const el = document.getElementById('mktStatus');
  const map = { open:['● Open','mkt-open'], pre:['● Pre-Market','mkt-pre'], post:['● After Hours','mkt-pre'], closed:['● Closed','mkt-closed'] };
  const [text, cls] = map[mkt] || map.closed;
  el.textContent = text;
  el.className = 'ph-status ' + cls;
}

// ==================== Footer Ticker ====================
function renderFooterTicker() {
  const syms = WATCHLISTS[state.activeList].slice(0, 14);
  const items = syms.map(sym => {
    const q = state.quotes[sym];
    if (!q) return `<span class="tk-item"><span class="tk-sym">${sym}</span></span>`;
    const chg = q.regularMarketChange ?? 0;
    const dir = chg >= 0 ? 'up' : 'down';
    return `<span class="tk-item"><span class="tk-sym">${sym}</span><span class="tk-price">${fmt(q.regularMarketPrice)}</span><span class="tk-chg ${dir}">${fmtSign(chg)}</span></span><span class="tk-sep">│</span>`;
  });

  document.getElementById('footerTicker').innerHTML = items.join('');
}

// ==================== Search ====================
function setupSearch() {
  const input = document.getElementById('cmdInput');
  const results = document.getElementById('searchResults');

  input.addEventListener('input', () => {
    clearTimeout(state.searchTimeout);
    const q = input.value.trim();
    if (q.length < 1) { results.classList.remove('open'); return; }
    state.searchTimeout = setTimeout(async () => {
      try {
        const data = await fetchSearch(q);
        if (!data.quotes?.length) { results.classList.remove('open'); return; }
        results.innerHTML = data.quotes.slice(0, 8).map(r =>
          `<div class="sr-item" data-sym="${escHtml(r.symbol)}"><div><span class="sr-sym">${escHtml(r.symbol)}</span><span class="sr-name">${escHtml(r.shortname||r.longname||r.shortName||r.longName||'')}</span></div><span class="sr-type">${escHtml(r.quoteType||r.typeDisp||'')}</span></div>`
        ).join('');
        results.classList.add('open');
      } catch { results.classList.remove('open'); }
    }, 250);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const q = input.value.trim().toUpperCase();
      if (q) selectTicker(q);
      input.value = '';
      results.classList.remove('open');
    }
    if (e.key === 'Escape') { input.value = ''; results.classList.remove('open'); }
  });

  results.addEventListener('click', e => {
    const item = e.target.closest('.sr-item');
    if (item) { selectTicker(item.dataset.sym); input.value = ''; results.classList.remove('open'); }
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.t-header-center')) results.classList.remove('open');
  });
}

// ==================== Data Loading ====================
function getAllSymbols() {
  const s = new Set();
  (WATCHLISTS[state.activeList] || []).forEach(x => s.add(x));
  SECTOR_MAP.forEach(x => s.add(x.etf));
  INDEX_SYMBOLS.forEach(x => s.add(x.symbol));
  s.add(state.selectedTicker);
  return [...s];
}

async function loadAllQuotes() {
  try {
    const quotes = await fetchQuotes(getAllSymbols());
    for (const q of quotes) if (q.symbol) {
      state.quotes[q.symbol] = q;
      pushSparkPoint(q.symbol, q.regularMarketPrice);
    }
    updateSourceBadge();
    renderWatchlist();
    renderHeatmap();
    renderIndices();
    renderDetail();
    renderFooterTicker();
  } catch (e) {
    console.error('Quote load failed:', e);
  }
}

async function selectTicker(sym) {
  state.selectedTicker = sym;
  document.getElementById('chartTicker').textContent = sym;
  if (!state.quotes[sym]) {
    try {
      const quotes = await fetchQuotes([sym]);
      for (const q of quotes) state.quotes[q.symbol] = q;
    } catch {}
  }
  renderWatchlist();
  renderDetail();
  loadChart();
}

// ==================== Events ====================
function setupEvents() {
  document.getElementById('watchTabs').addEventListener('click', e => {
    const btn = e.target.closest('.pt');
    if (!btn?.dataset.list) return;
    switchList(btn.dataset.list);
  });

  document.getElementById('watchBody').addEventListener('click', e => {
    const row = e.target.closest('.wl-row');
    if (row?.dataset.sym) selectTicker(row.dataset.sym);
  });

  document.getElementById('chartRanges').addEventListener('click', e => {
    const btn = e.target.closest('.pt');
    if (!btn?.dataset.range) return;
    setChartRange(btn.dataset.range);
  });

  document.getElementById('heatBody').addEventListener('click', e => {
    const cell = e.target.closest('.heat-cell');
    if (cell?.dataset.sym) selectTicker(cell.dataset.sym);
  });

  document.getElementById('idxBody').addEventListener('click', e => {
    const card = e.target.closest('.idx-card');
    if (card?.dataset.sym) selectTicker(card.dataset.sym);
  });

  // Sortable column headers
  document.querySelector('.wl-hdr').addEventListener('click', e => {
    const col = (e.target.className.match(/wc-(\w+)/) || [])[1];
    if (!col) return;
    if (state.sortCol === col) {
      if (state.sortDir === 1) state.sortDir = -1;
      else { state.sortCol = null; state.sortDir = 1; }  // 3rd click clears
    } else { state.sortCol = col; state.sortDir = col === 'tk' || col === 'nm' ? 1 : -1; }
    renderWatchlist();
  });

  // Keyboard navigation
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    const key = e.key;
    if (key === '/') { e.preventDefault(); document.getElementById('cmdInput').focus(); return; }
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'j' || key === 'k') {
      e.preventDefault();
      const syms = getSortedSymbols();
      let i = syms.indexOf(state.selectedTicker);
      if (i === -1) i = 0;
      else i += (key === 'ArrowDown' || key === 'j') ? 1 : -1;
      i = Math.max(0, Math.min(syms.length - 1, i));
      selectTicker(syms[i]);
      const row = document.querySelector(`.wl-row[data-sym="${CSS.escape(syms[i])}"]`);
      if (row) row.scrollIntoView({ block: 'nearest' });
      return;
    }
    // Tab through watchlists with [ and ]
    if (key === '[' || key === ']') {
      e.preventDefault();
      const lists = Object.keys(WATCHLISTS);
      let li = lists.indexOf(state.activeList) + (key === ']' ? 1 : -1);
      li = (li + lists.length) % lists.length;
      switchList(lists[li]);
      return;
    }
    // Number keys 1-6 switch chart range
    const ranges = ['1d','5d','1mo','3mo','1y','5y'];
    if (/^[1-6]$/.test(key)) {
      e.preventDefault();
      const r = ranges[parseInt(key, 10) - 1];
      setChartRange(r);
    }
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { renderChart(); renderHeatmap(); }, 150);
  });

  setupSearch();
}

function switchList(list) {
  state.activeList = list;
  document.querySelectorAll('#watchTabs .pt').forEach(b => b.classList.toggle('active', b.dataset.list === list));
  loadAllQuotes();
}

function setChartRange(range) {
  state.chartRange = range;
  document.querySelectorAll('#chartRanges .pt').forEach(b => b.classList.toggle('active', b.dataset.range === range));
  loadChart();
}

// ==================== Init ====================
async function init() {
  updateClock();
  setInterval(updateClock, 1000);
  setupEvents();

  await loadAllQuotes();
  await Promise.all([loadChart(), loadNews()]);

  setInterval(loadAllQuotes, QUOTE_INTERVAL);
  setInterval(loadChart, CHART_INTERVAL);
  setInterval(loadNews, NEWS_INTERVAL);
}

init();
