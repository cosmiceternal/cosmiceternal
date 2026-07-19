/* Player stats dashboard — renders the Overview charts (profit trend + by-game
   breakdown), the bet History list, and wires the tab switching for the Stats
   modal. Data comes from /api/stats, /api/stats/detail and /api/history. */
(function (global) {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => (global.Bankroll ? Bankroll.fmt(Number(n) || 0) : (Number(n) || 0).toFixed(2));
  const fmtC = (n) => (global.Bankroll && Bankroll.fmtCompact) ? Bankroll.fmtCompact(Number(n) || 0) : String(Math.round(Number(n) || 0));
  const nameOf = (k) => (global.GameCatalog && GameCatalog.nameOf) ? GameCatalog.nameOf(k) : k;
  const ago = (ts) => { const s = Math.floor((Date.now() - ts) / 1000); if (s < 60) return s + 's'; if (s < 3600) return Math.floor(s / 60) + 'm'; if (s < 86400) return Math.floor(s / 3600) + 'h'; return Math.floor(s / 86400) + 'd'; };

  const TEAL = '#5fe3c0', PINK = '#ff5e9c', MUTED = '#948aa6';

  // Cumulative-profit area chart. series: [{ts, cumulative, ...}]
  function renderTrend(el, series) {
    if (!el) return;
    if (!series || !series.length || series.every(s => s.bets === 0)) { el.innerHTML = '<div class="stats-empty">No plays yet — your profit trend will appear here.</div>'; return; }
    const W = 520, H = 150, P = { l: 46, r: 10, t: 12, b: 20 };
    const vals = series.map(s => s.cumulative);
    let min = Math.min(0, ...vals), max = Math.max(0, ...vals);
    if (min === max) { min -= 1; max += 1; }
    const span = (max - min) * 0.12; min -= span; max += span;
    const x = (i) => P.l + (series.length <= 1 ? (W - P.l - P.r) / 2 : (i / (series.length - 1)) * (W - P.l - P.r));
    const y = (v) => P.t + (H - P.t - P.b) - ((v - min) / (max - min)) * (H - P.t - P.b);
    const end = vals[vals.length - 1], col = end >= 0 ? TEAL : PINK, zeroY = y(0);
    const pts = series.map((s, i) => `${x(i).toFixed(1)},${y(s.cumulative).toFixed(1)}`);
    let g = '';
    g += `<line x1="${P.l}" y1="${zeroY.toFixed(1)}" x2="${W - P.r}" y2="${zeroY.toFixed(1)}" stroke="rgba(255,255,255,0.13)" stroke-dasharray="3 3"/>`;
    g += `<text x="${P.l - 6}" y="${(zeroY + 3).toFixed(1)}" text-anchor="end" fill="${MUTED}" font-size="10">0</text>`;
    g += `<text x="${P.l - 6}" y="${(P.t + 8).toFixed(1)}" text-anchor="end" fill="${MUTED}" font-size="10">${fmtC(max)}</text>`;
    g += `<text x="${P.l - 6}" y="${(H - P.b).toFixed(1)}" text-anchor="end" fill="${MUTED}" font-size="10">${fmtC(min)}</text>`;
    const area = `M${x(0).toFixed(1)},${zeroY.toFixed(1)} L` + pts.join(' L') + ` L${x(series.length - 1).toFixed(1)},${zeroY.toFixed(1)} Z`;
    g += `<path d="${area}" fill="${col}" opacity="0.14"/>`;
    g += `<polyline points="${pts.join(' ')}" fill="none" stroke="${col}" stroke-width="2"/>`;
    g += `<circle cx="${x(series.length - 1).toFixed(1)}" cy="${y(end).toFixed(1)}" r="3.5" fill="${col}"/>`;
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${g}</svg>`;
  }

  // Per-game breakdown bars.
  function renderGames(el, perGame) {
    if (!el) return;
    if (!perGame || !perGame.length) { el.innerHTML = '<div class="stats-empty">No plays yet.</div>'; return; }
    const maxBets = Math.max(1, ...perGame.map(g => g.bets));
    el.innerHTML = perGame.map(g => {
      const w = (g.bets / maxBets) * 100;
      const pc = g.profit >= 0 ? 'win' : 'loss';
      return `<div class="stats-game">
        <div class="sg-top"><span class="sg-name">${esc(nameOf(g.game))}</span><span class="sg-profit ${pc}">${g.profit >= 0 ? '+' : '−'}${fmt(Math.abs(g.profit))}</span></div>
        <div class="sg-bar"><span style="width:${w.toFixed(0)}%"></span></div>
        <div class="sg-sub muted">${g.bets.toLocaleString()} plays · ${(g.winRate * 100).toFixed(0)}% win · ${fmt(g.wagered)} wagered</div>
      </div>`;
    }).join('');
  }

  // Bet history list.
  function renderHistory(ul, bets) {
    if (!ul) return;
    if (!bets || !bets.length) { ul.innerHTML = '<li class="stats-empty">No bets yet — place one and it\'ll show up here.</li>'; return; }
    ul.innerHTML = bets.map(b => {
      const profit = (typeof b.profit === 'number') ? b.profit : ((b.payout || 0) - b.bet);
      const pc = profit >= 0 ? 'win' : 'loss';
      return `<li class="stats-hist-row">
        <span class="shr-game">${esc(nameOf(b.game))}</span>
        <span class="num">${fmt(b.bet)}</span>
        <span class="num">${b.win ? b.mult.toFixed(2) + '×' : '—'}</span>
        <span class="num ${pc}">${profit >= 0 ? '+' : '−'}${fmt(Math.abs(profit))}</span>
        <span class="num muted">${ago(b.ts)}</span>
      </li>`;
    }).join('');
  }

  // Wire tabs once; History lazy-loads via onHistory the first time it's opened.
  let onHistory = null, historyLoaded = false, wired = false;
  function init(historyLoader) {
    onHistory = historyLoader;
    if (wired) return;
    wired = true;
    document.querySelectorAll('.stats-tab').forEach(t => t.addEventListener('click', () => show(t.dataset.tab)));
  }
  function show(tab) {
    document.querySelectorAll('.stats-tab').forEach(x => x.classList.toggle('active', x.dataset.tab === tab));
    $('statsPaneOverview').classList.toggle('hidden', tab !== 'overview');
    $('statsPaneHistory').classList.toggle('hidden', tab !== 'history');
    $('statsPaneAch').classList.toggle('hidden', tab !== 'ach');
    if (tab === 'history' && !historyLoaded) { historyLoaded = true; if (onHistory) onHistory(); }
  }
  // Called on each modal open: reset to Overview and let history reload.
  function reset() { historyLoaded = false; show('overview'); }

  global.PlayerStats = { init, reset, renderTrend, renderGames, renderHistory };
})(window);
