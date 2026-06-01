/* Admin console. Visible only to users with isAdmin=true. Tabs:
 *   - Overview: aggregate stats (users, bets, wagered, house edge).
 *   - Users:    searchable user table with per-row actions.
 *   - Bets:     newest 100 bets across all users.
 *   - Audit:    newest 100 audit-log events. */
(function (global) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const fmt = (n) => (global.Bankroll ? Bankroll.fmt(n) : (+n).toFixed(2));
  const ago = (ts) => {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60)    return s + 's ago';
    if (s < 3600)  return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  };
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);

  let modal, userModal;
  let activeTab = 'overview';

  function open() {
    modal.classList.remove('hidden');
    showPane(activeTab);
  }
  function close() { modal.classList.add('hidden'); }
  function closeUser() { userModal.classList.add('hidden'); }

  function showPane(name) {
    activeTab = name;
    document.querySelectorAll('.admin-tab').forEach(t => t.classList.toggle('active', t.dataset.atab === name));
    [
      ['overview', 'adminOverview'],
      ['users',    'adminUsersPane'],
      ['bets',     'adminBetsPane'],
      ['audit',    'adminAuditPane']
    ].forEach(([k, id]) => $(id).classList.toggle('hidden', k !== name));
    if (name === 'overview') loadOverview();
    if (name === 'users')    loadUsers();
    if (name === 'bets')     loadBets();
    if (name === 'audit')    loadAudit();
  }

  async function loadOverview() {
    try {
      const o = await API.adminOverview();
      $('adminStats').innerHTML = `
        ${stat('Users', o.users.toLocaleString())}
        ${stat('Total Balance', fmt(o.totalBalance) + ' CRYPT')}
        ${stat('Bets',  o.bets.toLocaleString())}
        ${stat('Wagered', fmt(o.wagered) + ' CRYPT')}
        ${stat('Paid Out', fmt(o.paidOut) + ' CRYPT')}
        ${stat('House Edge', (o.houseEdge * 100).toFixed(2) + '%')}
        ${stat('Total XP', o.totalXp.toLocaleString())}
        ${stat('Locked Accounts', o.lockedUsers)}
      `;
    } catch (e) { Toast.error(e.message); }
  }
  function stat(label, value) {
    return `<div class="admin-stat-card">
      <div class="admin-stat-label">${escapeHtml(label)}</div>
      <div class="admin-stat-value">${escapeHtml(value)}</div>
    </div>`;
  }

  async function loadUsers() {
    const search = $('adminSearch').value.trim();
    try {
      const r = await API.adminUsers({ search, limit: 100 });
      const tbody = $('adminUsersTable').querySelector('tbody');
      tbody.innerHTML = (r.users || []).map(u => `
        <tr data-id="${u.id}">
          <td>${u.id}</td>
          <td><span class="adm-user">${escapeHtml(u.username)}</span></td>
          <td class="num">${fmt(u.balance)}</td>
          <td>L${u.level}</td>
          <td class="num">${u.betCount.toLocaleString()}</td>
          <td class="num">${fmt(u.wagered)}</td>
          <td>${u.isAdmin ? '<span class="adm-tag adm-admin">ADMIN</span> ' : ''}${u.locked ? '<span class="adm-tag adm-locked">LOCKED</span>' : ''}</td>
          <td><button class="btn btn-ghost adm-view">View</button></td>
        </tr>`).join('') || `<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:18px;">No users.</td></tr>`;
      tbody.querySelectorAll('tr').forEach(tr => {
        tr.querySelector('.adm-view')?.addEventListener('click', () => openUser(Number(tr.dataset.id)));
      });
    } catch (e) { Toast.error(e.message); }
  }

  async function openUser(id) {
    try {
      const r = await API.adminUser(id);
      $('adminUserTitle').textContent = `${r.user.username} (id ${r.user.id})`;
      $('adminUserBody').innerHTML = `
        <div class="adm-user-grid">
          <div class="adm-card">
            <div class="adm-card-label">Balance</div>
            <div class="adm-card-value">${fmt(r.user.balance)} CRYPT</div>
            <div class="adm-actions">
              <input type="number" id="admAdjAmount" step="0.01" value="100" />
              <button class="btn" id="admAdd">Add</button>
              <button class="btn" id="admSet">Set</button>
            </div>
          </div>
          <div class="adm-card">
            <div class="adm-card-label">Level / XP</div>
            <div class="adm-card-value">L${r.user.level} · ${r.user.xp.toLocaleString()} XP</div>
            <div class="adm-card-sub">Streak day ${r.user.streakDay}</div>
          </div>
          <div class="adm-card">
            <div class="adm-card-label">Status</div>
            <div class="adm-card-value">${r.user.isAdmin ? 'Admin' : 'Player'} ${r.user.locked ? '· LOCKED' : ''}</div>
            <div class="adm-actions">
              <button class="btn" id="admLock">${r.user.locked ? 'Unlock' : 'Lock'}</button>
              <button class="btn" id="admPromote">${r.user.isAdmin ? 'Demote' : 'Promote'}</button>
            </div>
          </div>
        </div>
        <h3 class="adm-section">Recent bets</h3>
        <table class="admin-table compact">
          <thead><tr><th>Game</th><th>Bet</th><th>Mult</th><th>Profit</th><th>When</th></tr></thead>
          <tbody>${r.bets.map(b => `
            <tr><td>${escapeHtml(b.game)}</td><td class="num">${fmt(b.bet)}</td><td>${b.mult.toFixed(2)}×</td>
                <td class="num ${b.win ? 'win' : 'loss'}">${b.win ? '+' : '−'}${fmt(Math.abs(b.payout - b.bet))}</td>
                <td>${ago(b.ts)}</td></tr>`).join('') || '<tr><td colspan=5 class="adm-empty">No bets.</td></tr>'}</tbody>
        </table>
        <h3 class="adm-section">Recent audit events</h3>
        <table class="admin-table compact">
          <thead><tr><th>Event</th><th>IP</th><th>Meta</th><th>When</th></tr></thead>
          <tbody>${r.audit.map(a => `
            <tr><td>${escapeHtml(a.event)}</td><td>${escapeHtml(a.ip || '')}</td>
                <td><code>${escapeHtml(a.meta ? JSON.stringify(a.meta) : '')}</code></td>
                <td>${ago(a.ts)}</td></tr>`).join('') || '<tr><td colspan=4 class="adm-empty">No events.</td></tr>'}</tbody>
        </table>`;
      userModal.classList.remove('hidden');

      $('admAdd').addEventListener('click', () => adjustBal(id, 'add'));
      $('admSet').addEventListener('click', () => adjustBal(id, 'set'));
      $('admLock').addEventListener('click', async () => {
        try { await API.adminLock(id, { locked: !r.user.locked }); Toast.info('Lock toggled'); openUser(id); }
        catch (e) { Toast.error(e.message); }
      });
      $('admPromote').addEventListener('click', async () => {
        try { await API.adminPromote(id, { isAdmin: !r.user.isAdmin }); Toast.info('Admin toggled'); openUser(id); }
        catch (e) { Toast.error(e.message); }
      });
    } catch (e) { Toast.error(e.message); }
  }

  async function adjustBal(id, mode) {
    const amount = Number($('admAdjAmount').value);
    if (!isFinite(amount)) { Toast.warn('Enter a number'); return; }
    try {
      const r = await API.adminBalance(id, { mode, amount });
      Toast.win(`Balance now ${fmt(r.newBalance)} CRYPT`);
      openUser(id);
    } catch (e) { Toast.error(e.message); }
  }

  async function loadBets() {
    try {
      const r = await API.adminBets(100);
      const tbody = $('adminBetsTable').querySelector('tbody');
      tbody.innerHTML = r.bets.map(b => {
        const profit = b.payout - b.bet;
        return `<tr>
          <td>${b.id}</td>
          <td>${escapeHtml(b.username)}</td>
          <td>${escapeHtml(b.game)}</td>
          <td class="num">${fmt(b.bet)}</td>
          <td>${b.mult.toFixed(2)}×</td>
          <td class="num ${profit >= 0 ? 'win' : 'loss'}">${profit >= 0 ? '+' : '−'}${fmt(Math.abs(profit))}</td>
          <td>${ago(b.ts)}</td>
        </tr>`;
      }).join('') || `<tr><td colspan="7" class="adm-empty">No bets.</td></tr>`;
    } catch (e) { Toast.error(e.message); }
  }

  async function loadAudit() {
    try {
      const r = await API.adminAudit(100);
      const tbody = $('adminAuditTable').querySelector('tbody');
      tbody.innerHTML = r.events.map(e => `
        <tr>
          <td>${escapeHtml(e.event)}</td>
          <td>${escapeHtml(e.username || '—')}</td>
          <td>${escapeHtml(e.ip || '')}</td>
          <td><code>${escapeHtml(e.meta ? JSON.stringify(e.meta) : '')}</code></td>
          <td>${ago(e.ts)}</td>
        </tr>`).join('') || `<tr><td colspan="5" class="adm-empty">No events.</td></tr>`;
    } catch (e) { Toast.error(e.message); }
  }

  function wire(user) {
    modal = $('adminModal');
    userModal = $('adminUserModal');
    if (!modal) return;
    const btn = $('btnAdmin');
    if (user && user.isAdmin) btn.classList.remove('hidden');
    btn.addEventListener('click', open);
    $('adminClose').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    $('adminUserClose').addEventListener('click', closeUser);
    userModal.addEventListener('click', (e) => { if (e.target === userModal) closeUser(); });
    document.querySelectorAll('.admin-tab').forEach(t => t.addEventListener('click', () => showPane(t.dataset.atab)));
    $('adminUsersRefresh').addEventListener('click', loadUsers);
    let debouncing;
    $('adminSearch').addEventListener('input', () => {
      clearTimeout(debouncing);
      debouncing = setTimeout(loadUsers, 250);
    });
  }

  global.Admin = { wire, open };
})(window);
