/* Crypt Casino — Admin Console logic. Self-contained: talks to the same-origin
   /api/admin/* endpoints (session cookie flows automatically), echoes the CSRF
   cookie on state-changing requests, and renders everything by hand — no deps. */
(function () {
  'use strict';

  // ---------- tiny helpers ----------
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtC = (n) => { n = Number(n || 0); const a = Math.abs(n); if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return (n / 1e3).toFixed(1) + 'k'; return String(Math.round(n)); };
  const pct = (n) => (Number(n || 0) * 100).toFixed(2) + '%';
  const ago = (ts) => { const s = Math.floor((Date.now() - ts) / 1000); if (s < 60) return s + 's'; if (s < 3600) return Math.floor(s / 60) + 'm'; if (s < 86400) return Math.floor(s / 3600) + 'h'; return Math.floor(s / 86400) + 'd'; };
  const dayLabel = (ts) => { const d = new Date(ts); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate(); };

  function csrf() { const m = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/); return m ? decodeURIComponent(m[1]) : ''; }
  async function api(method, path, body) {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['X-CSRF-Token'] = csrf();
    const res = await fetch(path, { method, headers, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data;
  }
  const GET = (p) => api('GET', p);
  const POST = (p, b) => api('POST', p, b);

  function toast(msg, kind) {
    const t = el('div', 'toast' + (kind ? ' ' + kind : ''), esc(msg));
    $('toasts').appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 3200);
  }

  // ---------- SVG charts (lightweight, themed) ----------
  const COL = { accent: '#ff5e9c', teal: '#5fe3c0', gold: '#ffc061', violet: '#a07bff', muted: '#948aa6' };
  const W = 560, H = 200, PAD = { l: 44, r: 12, t: 12, b: 26 };

  function scaleY(v, max) { const h = H - PAD.t - PAD.b; return PAD.t + h - (max > 0 ? (v / max) * h : 0); }
  function xAt(i, n) { const w = W - PAD.l - PAD.r; return PAD.l + (n <= 1 ? w / 2 : (i / (n - 1)) * w); }
  function yGrid(max, fmtV) {
    let s = '';
    for (let k = 0; k <= 4; k++) {
      const v = (max / 4) * k, y = scaleY(v, max);
      s += `<line class="c-grid" x1="${PAD.l}" y1="${y.toFixed(1)}" x2="${W - PAD.r}" y2="${y.toFixed(1)}"/>`;
      s += `<text class="c-axis" x="${PAD.l - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${fmtV(v)}</text>`;
    }
    return s;
  }
  function xLabels(items, n) {
    const step = Math.ceil(n / 8);
    let s = '';
    items.forEach((it, i) => { if (i % step === 0 || i === n - 1) s += `<text class="c-axis" x="${xAt(i, n).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(it.label)}</text>`; });
    return s;
  }
  function svg(inner) { return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${inner}</svg>`; }

  // Multi-series line chart. series: [{key,color}], data: [{label, [key]:num}]
  function lineChart(node, data, series, fmtV) {
    fmtV = fmtV || fmtC;
    if (!data.length) { node.innerHTML = '<div class="c-empty">No data in range.</div>'; return; }
    const n = data.length;
    let max = 0; data.forEach(d => series.forEach(s => { max = Math.max(max, Number(d[s.key] || 0)); }));
    max = max || 1; max *= 1.1;
    let g = yGrid(max, fmtV) + xLabels(data, n);
    series.forEach(s => {
      const pts = data.map((d, i) => `${xAt(i, n).toFixed(1)},${scaleY(Number(d[s.key] || 0), max).toFixed(1)}`);
      const area = `M${PAD.l},${scaleY(0, max).toFixed(1)} L` + pts.join(' L') + ` L${(W - PAD.r).toFixed(1)},${scaleY(0, max).toFixed(1)} Z`;
      g += `<path class="c-area" d="${area}" fill="${s.color}"/>`;
      g += `<polyline class="c-line" points="${pts.join(' ')}" stroke="${s.color}"/>`;
      if (n <= 20) data.forEach((d, i) => { g += `<circle class="c-dot" cx="${xAt(i, n).toFixed(1)}" cy="${scaleY(Number(d[s.key] || 0), max).toFixed(1)}" r="2.5" fill="${s.color}"/>`; });
    });
    const legend = series.length > 1 ? `<div class="c-legend">${series.map(s => `<span><i class="c-swatch" style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';
    node.innerHTML = svg(g) + legend;
  }

  // Bar chart. data: [{label, value, sub?}]
  function barChart(node, data, color, fmtV, horizontal) {
    fmtV = fmtV || fmtC;
    if (!data.length) { node.innerHTML = '<div class="c-empty">No data in range.</div>'; return; }
    const max = (Math.max(...data.map(d => Number(d.value || 0))) || 1) * 1.1;
    if (horizontal) {
      const rowH = 26, h = data.length * rowH + 8, w = W;
      let g = '';
      data.forEach((d, i) => {
        const y = i * rowH + 4, bw = (max > 0 ? (Number(d.value || 0) / max) : 0) * (w - 160);
        g += `<text class="c-axis" x="4" y="${y + 15}" style="font-size:11px;fill:var(--text)">${esc(d.label)}</text>`;
        g += `<rect x="120" y="${y + 4}" width="${Math.max(1, bw).toFixed(1)}" height="14" rx="4" fill="${color}" opacity="0.85"/>`;
        g += `<text class="c-axis" x="${(120 + bw + 6).toFixed(1)}" y="${y + 15}">${fmtV(d.value)}${d.sub ? '  ·  ' + esc(d.sub) : ''}</text>`;
      });
      node.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">${g}</svg>`;
      return;
    }
    const n = data.length, bw = Math.min(34, (W - PAD.l - PAD.r) / n * 0.62);
    let g = yGrid(max, fmtV) + xLabels(data, n);
    data.forEach((d, i) => {
      const x = xAt(i, n), y = scaleY(Number(d.value || 0), max), h = scaleY(0, max) - y;
      g += `<rect x="${(x - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="3" fill="${color}" opacity="0.85"/>`;
    });
    node.innerHTML = svg(g);
  }

  // ---------- views ----------
  let currentView = 'overview';
  let analyticsDays = 14;
  let liveTimer = null, liveSinceId = 0, livePaused = true;

  function switchView(name) {
    currentView = name;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    ['overview', 'users', 'financial', 'live', 'audit'].forEach(v => { $('view-' + v).hidden = v !== name; });
    $('viewTitle').textContent = { overview: 'Overview', users: 'Users', financial: 'Financial', live: 'Live monitor', audit: 'Audit log' }[name];
    renderToplineActions(name);
    if (name === 'overview') loadOverview();
    if (name === 'users') loadUsers();
    if (name === 'financial') loadFinancial();
    if (name === 'audit') loadAudit();
    // live polling only runs while its view is open
    if (name === 'live') startLive(); else stopLive();
  }

  function renderToplineActions(name) {
    const box = $('toplineActions'); box.innerHTML = '';
    if (name === 'overview') {
      const seg = el('div', 'seg');
      [7, 14, 30].forEach(d => { const b = el('button', d === analyticsDays ? 'active' : '', d + 'd'); b.onclick = () => { analyticsDays = d; loadOverview(); }; seg.appendChild(b); });
      box.appendChild(seg);
    }
  }

  // ----- Overview -----
  async function loadOverview() {
    renderToplineActions('overview');
    try {
      const [o, a] = await Promise.all([GET('/api/admin/overview'), GET('/api/admin/analytics?days=' + analyticsDays)]);
      $('ovStats').innerHTML = [
        statCard('Users', o.users.toLocaleString(), o.lockedUsers + ' locked', ''),
        statCard('Total balance', fmtC(o.totalBalance), 'CRYPT in play', 'violet'),
        statCard('Bets', o.bets.toLocaleString(), '', ''),
        statCard('Wagered', fmtC(o.wagered), 'CRYPT turnover', 'teal'),
        statCard('House edge', pct(o.houseEdge), fmtC(o.wagered - o.paidOut) + ' CRYPT revenue', 'gold'),
        statCard('Total XP', o.totalXp.toLocaleString(), '', '')
      ].join('');
      $('ovRangeLabel').textContent = a.days + ' days';
      const s = a.series;
      lineChart($('chartVolume'), s.map(d => ({ label: dayLabel(d.ts), wagered: d.wagered, paidOut: d.paidOut })),
        [{ key: 'wagered', color: COL.teal, name: 'Wagered' }, { key: 'paidOut', color: COL.accent, name: 'Paid out' }]);
      lineChart($('chartEdge'), s.map(d => ({ label: dayLabel(d.ts), edge: d.houseEdge * 100 })),
        [{ key: 'edge', color: COL.gold, name: 'House edge %' }], (v) => v.toFixed(0) + '%');
      barChart($('chartUsers'), s.map(d => ({ label: dayLabel(d.ts), value: d.newUsers })), COL.violet, (v) => String(Math.round(v)));
      lineChart($('chartFlows'), s.map(d => ({ label: dayLabel(d.ts), deposits: d.deposits, withdrawals: d.withdrawals })),
        [{ key: 'deposits', color: COL.teal, name: 'Deposits' }, { key: 'withdrawals', color: COL.accent, name: 'Withdrawals' }]);
      barChart($('chartGames'), a.topGames.map(g => ({ label: g.game, value: g.wagered, sub: pct(g.houseEdge) + ' edge' })), COL.accent, fmtC, true);
    } catch (e) { toast(e.message, 'err'); }
  }
  function statCard(label, value, sub, cls) {
    return `<div class="stat-card ${cls || ''}"><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(value)}</div><div class="stat-sub">${esc(sub || '')}</div></div>`;
  }

  // ----- Users -----
  async function loadUsers() {
    try {
      const r = await GET('/api/admin/users?limit=100&search=' + encodeURIComponent($('userSearch').value.trim()));
      const tb = $('usersTable').querySelector('tbody');
      tb.innerHTML = (r.users || []).map(u => `
        <tr data-id="${u.id}">
          <td>${u.id}</td>
          <td><b>${esc(u.username)}</b></td>
          <td class="num">${fmt(u.balance)}</td>
          <td>L${u.level}</td>
          <td class="num">${u.betCount.toLocaleString()}</td>
          <td class="num">${fmt(u.wagered)}</td>
          <td>${u.isAdmin ? '<span class="tag admin">ADMIN</span> ' : ''}${u.locked ? '<span class="tag locked">LOCKED</span>' : ''}</td>
          <td><button class="link-btn" data-view-user="${u.id}">Manage →</button></td>
        </tr>`).join('') || '<tr class="tbl-empty"><td colspan="8">No users.</td></tr>';
      tb.querySelectorAll('[data-view-user]').forEach(b => b.onclick = () => openUser(Number(b.dataset.viewUser)));
    } catch (e) { toast(e.message, 'err'); }
  }

  async function openUser(id) {
    try {
      const r = await GET('/api/admin/user/' + id);
      const u = r.user;
      const tierTag = `<span class="tag ${u.depositTier}">${u.depositTier.toUpperCase()}</span>`;
      const prog = Math.min(100, u.unlockTurnover > 0 ? (u.turnover / u.unlockTurnover) * 100 : 100);
      $('drawerInner').innerHTML = `
        <div class="drawer-head">
          <h2>${esc(u.username)} <span class="muted" style="font-size:13px">id ${u.id}</span></h2>
          <button class="btn btn-ghost" id="drawerClose">✕</button>
        </div>
        <div class="d-grid">
          <div class="d-card">
            <div class="d-label">Balance</div><div class="d-value">${fmt(u.balance)} <span class="muted" style="font-size:12px">CRYPT</span></div>
            <div class="d-actions"><input type="number" id="dAmt" value="100" step="0.01"/><button class="btn btn-sm" id="dAdd">Add</button><button class="btn btn-sm" id="dSet">Set</button></div>
          </div>
          <div class="d-card">
            <div class="d-label">Level / XP</div><div class="d-value">L${u.level}</div>
            <div class="muted" style="font-size:12px">${u.xp.toLocaleString()} XP · streak ${u.streakDay}d</div>
          </div>
          <div class="d-card">
            <div class="d-label">Status</div><div class="d-value" style="font-size:15px">${u.isAdmin ? 'Admin' : 'Player'}${u.locked ? ' · <span class="loss">LOCKED</span>' : ''}</div>
            <div class="d-actions"><button class="btn btn-sm" id="dLock">${u.locked ? 'Unlock' : 'Lock'}</button><button class="btn btn-sm" id="dPromote">${u.isAdmin ? 'Demote' : 'Promote'}</button></div>
          </div>
          <div class="d-card">
            <div class="d-label">Moderation</div><div class="d-value" style="font-size:15px">Seeds & sessions</div>
            <div class="d-actions"><button class="btn btn-sm" id="dSeeds">Reset seeds</button><button class="btn btn-sm" id="dLogout">Force logout</button></div>
          </div>
          <div class="d-card full">
            <div class="d-label">Deposit limit ${tierTag}</div>
            <div class="d-value" style="font-size:15px">${fmt(u.depositCap)} CRYPT/day ${u.depositLimitOverride != null ? '<span class="muted" style="font-size:12px">(manual override)</span>' : ''}</div>
            <div class="muted" style="font-size:12px">Turnover ${fmt(u.turnover)} / ${fmt(u.unlockTurnover)} to unlock full cap</div>
            <div class="d-progress"><span style="width:${prog.toFixed(0)}%"></span></div>
            <div class="d-actions" style="margin-top:10px"><input type="number" id="dLimit" placeholder="override" step="1" value="${u.depositLimitOverride != null ? u.depositLimitOverride : ''}"/><button class="btn btn-sm" id="dLimitSet">Set cap</button><button class="btn btn-sm" id="dLimitClear">Clear</button></div>
          </div>
        </div>
        <div class="d-section">Recent bets</div>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>Game</th><th class="num">Bet</th><th class="num">Mult</th><th class="num">Profit</th><th>When</th></tr></thead><tbody>
          ${r.bets.map(b => `<tr><td>${esc(b.game)}</td><td class="num">${fmt(b.bet)}</td><td class="num">${b.mult.toFixed(2)}×</td><td class="num ${b.win ? 'win' : 'loss'}">${b.win ? '+' : '−'}${fmt(Math.abs(b.payout - b.bet))}</td><td>${ago(b.ts)}</td></tr>`).join('') || '<tr class="tbl-empty"><td colspan="5">No bets.</td></tr>'}
        </tbody></table></div>
        <div class="d-section">Recent audit</div>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>Event</th><th>IP</th><th>When</th></tr></thead><tbody>
          ${r.audit.map(a => `<tr><td>${esc(a.event)}</td><td class="muted">${esc(a.ip || '')}</td><td>${ago(a.ts)}</td></tr>`).join('') || '<tr class="tbl-empty"><td colspan="3">No events.</td></tr>'}
        </tbody></table></div>`;
      $('userDrawer').hidden = false;

      const refresh = () => openUser(id);
      $('drawerClose').onclick = closeDrawer;
      $('dAdd').onclick = () => adjust(id, 'add', refresh);
      $('dSet').onclick = () => adjust(id, 'set', refresh);
      $('dLock').onclick = () => act(() => POST(`/api/admin/user/${id}/lock`, { locked: !u.locked }), u.locked ? 'Unlocked' : 'Locked', refresh);
      $('dPromote').onclick = () => act(() => POST(`/api/admin/user/${id}/admin`, { isAdmin: !u.isAdmin }), 'Admin toggled', refresh);
      $('dSeeds').onclick = () => act(() => POST(`/api/admin/user/${id}/reset-seeds`), 'Seeds rotated', refresh);
      $('dLogout').onclick = () => act(() => POST(`/api/admin/user/${id}/logout`), 'Sessions cleared', refresh);
      $('dLimitSet').onclick = () => act(() => POST(`/api/admin/user/${id}/deposit-limit`, { limit: Number($('dLimit').value) }), 'Deposit cap set', refresh);
      $('dLimitClear').onclick = () => act(() => POST(`/api/admin/user/${id}/deposit-limit`, { limit: null }), 'Override cleared', refresh);
    } catch (e) { toast(e.message, 'err'); }
  }
  function closeDrawer() { $('userDrawer').hidden = true; }
  async function adjust(id, mode, done) {
    const amount = Number($('dAmt').value);
    if (!isFinite(amount)) { toast('Enter a number', 'err'); return; }
    act(() => POST(`/api/admin/user/${id}/balance`, { mode, amount }), 'Balance updated', done);
  }
  async function act(fn, okMsg, done) { try { await fn(); toast(okMsg, 'ok'); if (done) done(); if (currentView === 'users') loadUsers(); } catch (e) { toast(e.message, 'err'); } }

  // ----- Financial -----
  async function loadFinancial() {
    try {
      const s = await GET('/api/admin/settings');
      $('depNew').value = s.deposit.newCap; $('depUnlock').value = s.deposit.unlock; $('depFull').value = s.deposit.fullCap;
    } catch (e) { toast(e.message, 'err'); }
    loadWithdrawals();
  }
  async function loadWithdrawals() {
    try {
      const r = await GET('/api/admin/withdrawals?limit=100');
      const tb = $('wdTable').querySelector('tbody');
      tb.innerHTML = (r.withdrawals || []).map(w => `
        <tr>
          <td>${w.id}</td><td><b>${esc(w.username)}</b></td><td>${esc(w.currency)}</td>
          <td class="num">${w.amount}</td><td class="num">${fmt(w.funDebited)}</td>
          <td><code title="${esc(w.address)}">${esc(String(w.address).slice(0, 16))}…</code></td>
          <td>${esc(w.status)}</td>
          <td>${w.status === 'pending' ? `<button class="btn btn-sm btn-teal" data-wd="${w.id}" data-a="complete">✓</button> <button class="btn btn-sm" data-wd="${w.id}" data-a="cancel">Refund</button>` : ''}</td>
        </tr>`).join('') || '<tr class="tbl-empty"><td colspan="8">No withdrawals.</td></tr>';
      tb.querySelectorAll('[data-wd]').forEach(b => b.onclick = () => act(() => POST('/api/admin/withdrawal/' + b.dataset.wd, { action: b.dataset.a }), b.dataset.a === 'complete' ? 'Completed' : 'Refunded', loadWithdrawals));
    } catch (e) { toast(e.message, 'err'); }
  }

  // ----- Live -----
  function startLive() {
    livePaused = false; $('liveToggle').textContent = 'Pause'; $('liveStatus').textContent = 'Streaming live bets';
    pollLive();
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = setInterval(() => { if (!livePaused) pollLive(); }, 3000);
  }
  function stopLive() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }
  function toggleLive() {
    livePaused = !livePaused;
    $('liveToggle').textContent = livePaused ? 'Resume' : 'Pause';
    $('liveStatus').textContent = livePaused ? 'Feed paused' : 'Streaming live bets';
    if (!livePaused) pollLive();
  }
  async function pollLive() {
    try {
      const r = await GET('/api/admin/live?sinceId=' + liveSinceId + '&limit=40');
      if (!r.bets.length) return;
      liveSinceId = Math.max(liveSinceId, r.bets[0].id);
      const tb = $('liveTable').querySelector('tbody');
      // newest first; prepend
      r.bets.forEach(b => {
        const big = b.win && b.mult >= 10;
        const tr = el('tr', 'flash-in' + (big ? ' bigwin-row' : ''),
          `<td>${b.id}</td><td><b>${esc(b.username)}</b></td><td>${esc(b.game)}</td><td class="num">${fmt(b.bet)}</td><td class="num">${b.mult.toFixed(2)}×</td><td class="num ${b.profit >= 0 ? 'win' : 'loss'}">${b.profit >= 0 ? '+' : '−'}${fmt(Math.abs(b.profit))}</td><td>${ago(b.ts)}</td>`);
        tb.insertBefore(tr, tb.firstChild);
      });
      while (tb.children.length > 120) tb.removeChild(tb.lastChild);
    } catch (e) { /* silent during polling */ }
  }

  // ----- Audit -----
  async function loadAudit() {
    try {
      const r = await GET('/api/admin/audit?limit=100');
      const tb = $('auditTable').querySelector('tbody');
      tb.innerHTML = r.events.map(e => `<tr><td>${esc(e.event)}</td><td>${esc(e.username || '—')}</td><td class="muted">${esc(e.ip || '')}</td><td><code>${esc(e.meta ? JSON.stringify(e.meta) : '')}</code></td><td>${ago(e.ts)}</td></tr>`).join('') || '<tr class="tbl-empty"><td colspan="5">No events.</td></tr>';
    } catch (e) { toast(e.message, 'err'); }
  }

  // ---------- boot / auth ----------
  async function boot() {
    let me = null;
    try { me = (await GET('/api/me')).user; } catch (_) {}
    if (me && me.isAdmin) { showShell(me); }
    else { showGate(me ? 'That account is not an administrator.' : 'Sign in with an administrator account.'); }
  }
  function showGate(msg) { $('shell').hidden = true; $('gate').hidden = false; $('gateTag').textContent = msg; }
  function showShell(me) {
    $('gate').hidden = true; $('shell').hidden = false;
    $('who').textContent = '👤 ' + me.username;
    switchView('overview');
  }

  function wire() {
    document.querySelectorAll('.nav-item').forEach(b => b.onclick = () => switchView(b.dataset.view));
    $('usersRefresh').onclick = loadUsers;
    let deb; $('userSearch').oninput = () => { clearTimeout(deb); deb = setTimeout(loadUsers, 250); };
    $('auditRefresh').onclick = loadAudit;
    $('liveToggle').onclick = toggleLive;
    $('userDrawer').onclick = (e) => { if (e.target === $('userDrawer')) closeDrawer(); };
    $('btnSignout').onclick = async () => { try { await POST('/api/auth/logout'); } catch (_) {} location.reload(); };
    $('depForm').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await POST('/api/admin/settings', { deposit: { newCap: Number($('depNew').value), unlock: Number($('depUnlock').value), fullCap: Number($('depFull').value) } });
        $('depNote').textContent = 'Saved ✓'; setTimeout(() => $('depNote').textContent = '', 2500);
        toast('Deposit limits updated', 'ok');
      } catch (err) { toast(err.message, 'err'); }
    };
    $('gateForm').onsubmit = async (e) => {
      e.preventDefault();
      $('gateError').textContent = '';
      try {
        await POST('/api/auth/login', { username: $('gateUser').value.trim(), password: $('gatePass').value });
        boot();
      } catch (err) { $('gateError').textContent = err.message; }
    };
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  }

  wire();
  boot();
})();
