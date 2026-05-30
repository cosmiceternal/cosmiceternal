/* Crypto Vault — deposit flow. Same UI for play-money (default) and any
 * real processor that's swapped in via VAULT_PROCESSOR. In play-money mode
 * we animate a fake "confirmations" counter and call /api/vault/confirm to
 * settle. In real-processor mode the webhook drives settlement; we poll
 * /api/vault/history every 5s for the row's status to flip. */
(function (global) {
  'use strict';

  let modal, snap, selectedCurrency = 'BTC';
  let pollTimer = null, pendingDepositId = null, pendingCurrency = null;
  let confirmsRequired = 3, confirmsNow = 0;

  const $ = (id) => document.getElementById(id);
  const safeCopy = async (text) => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {}
    // Fallback for older browsers / no permission.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    return ok;
  };
  const truncate = (s, n) => (s && s.length > n) ? s.slice(0, n) + '…' : (s || '');
  const fmtCrypt = (n) => (global.Bankroll ? Bankroll.fmt(n) : (+n).toFixed(2));

  function open() {
    modal.classList.remove('hidden');
    refreshSnapshot();
    renderHistory();
    showPane('deposit');
    showCreateForm();
  }
  function close() {
    modal.classList.add('hidden');
    stopPolling();
  }

  function showPane(name) {
    $('vaultDepositPane').classList.toggle('hidden', name !== 'deposit');
    $('vaultHistoryPane').classList.toggle('hidden', name !== 'history');
    document.querySelectorAll('.vault-tab').forEach(t => t.classList.toggle('active', t.dataset.vtab === name));
    if (name === 'history') renderHistory();
  }
  function showCreateForm() {
    $('vaultDepositState').classList.add('hidden');
    $('vaultCreate').disabled = false;
    $('vaultCreate').textContent = 'Create Deposit';
    $('vaultAmount').disabled = false;
    document.querySelectorAll('.vault-currency-chip, .vault-preset').forEach(el => el.classList.remove('locked'));
  }

  async function refreshSnapshot() {
    try {
      snap = await API.vault();
    } catch (e) { Toast.error(e.message || 'Vault unavailable'); return; }
    $('vaultProcessorLine').textContent = snap.playmoney
      ? 'Play-money mode — deposits credit CRYPT instantly for the demo.'
      : `Processor: ${snap.processorLabel}.`;
    $('vaultHint').textContent = snap.playmoney
      ? 'No real crypto leaves your wallet — addresses are simulated.'
      : 'Send exactly the displayed amount to the displayed address.';
    $('vaultCapLine').textContent =
      `Daily cap: ${fmtCrypt(snap.dailyCapFun)} CRYPT  •  Used today: ${fmtCrypt(snap.dailyUsedFun)} CRYPT`;
    renderCurrencyChips();
    renderPresets();
    syncPreview();
  }

  function renderCurrencyChips() {
    const row = $('vaultCurrencyRow');
    row.innerHTML = '';
    snap.currencies.forEach(c => {
      const b = document.createElement('button');
      b.className = 'vault-currency-chip' + (c.code === selectedCurrency ? ' active' : '');
      b.dataset.code = c.code;
      b.innerHTML = `<span class="vcc-code">${c.code}</span><span class="vcc-rate muted">${c.funPerUnit.toLocaleString()} / unit</span>`;
      b.addEventListener('click', () => {
        selectedCurrency = c.code;
        $('vaultCurrencyLabel').textContent = c.code;
        $('vaultAmount').value = c.presets[0];
        renderCurrencyChips();
        renderPresets();
        syncPreview();
      });
      row.appendChild(b);
    });
    $('vaultCurrencyLabel').textContent = selectedCurrency;
  }

  function renderPresets() {
    const cfg = snap.currencies.find(c => c.code === selectedCurrency);
    const row = $('vaultPresetRow');
    row.innerHTML = '';
    if (!cfg) return;
    cfg.presets.forEach(amt => {
      const b = document.createElement('button');
      b.className = 'vault-preset';
      b.textContent = amt;
      b.addEventListener('click', () => { $('vaultAmount').value = amt; syncPreview(); });
      row.appendChild(b);
    });
  }

  function syncPreview() {
    const cfg = snap && snap.currencies.find(c => c.code === selectedCurrency);
    if (!cfg) return;
    const amt = Number($('vaultAmount').value) || 0;
    const crypt = amt * cfg.funPerUnit;
    $('vaultFunPreview').textContent = fmtCrypt(crypt) + ' CRYPT';
  }

  async function createDeposit() {
    const cfg = snap && snap.currencies.find(c => c.code === selectedCurrency);
    if (!cfg) return;
    const amount = Number($('vaultAmount').value);
    if (!isFinite(amount) || amount < cfg.min) {
      Toast.warn(`Minimum ${selectedCurrency} deposit is ${cfg.min}`);
      return;
    }
    $('vaultCreate').disabled = true;
    $('vaultCreate').textContent = 'Creating…';
    try {
      const res = await API.createDeposit({ currency: selectedCurrency, amount });
      enterDepositState(res);
    } catch (e) {
      Toast.error(e.message || 'Deposit failed');
      $('vaultCreate').disabled = false;
      $('vaultCreate').textContent = 'Create Deposit';
    }
  }

  function enterDepositState(res) {
    pendingDepositId = res.depositId;
    pendingCurrency = res.currency;
    confirmsRequired = res.confirmsRequired || 3;
    confirmsNow = 0;
    $('vaultStateUnits').textContent = res.amount;
    $('vaultStateCurrency').textContent = res.currency;
    $('vaultAddress').textContent = res.address;
    $('vaultConfirmNeed').textContent = confirmsRequired;
    $('vaultConfirmNow').textContent = '0';
    $('vaultConfirmFill').style.width = '0%';
    $('vaultDone').classList.add('hidden');
    $('vaultDepositState').classList.remove('hidden');
    $('vaultAmount').disabled = true;
    document.querySelectorAll('.vault-currency-chip, .vault-preset').forEach(el => el.classList.add('locked'));

    if (res.playmoney || snap.playmoney) {
      animatePlaymoneyConfirms(res);
    } else {
      startPolling(res.depositId, res.funCredited);
    }
  }

  function animatePlaymoneyConfirms(res) {
    const stepMs = 700;
    let step = 0;
    const tick = setInterval(() => {
      step++;
      confirmsNow = Math.min(step, confirmsRequired);
      $('vaultConfirmNow').textContent = confirmsNow;
      $('vaultConfirmFill').style.width = (confirmsNow / confirmsRequired * 100) + '%';
      if (confirmsNow >= confirmsRequired) {
        clearInterval(tick);
        settlePlaymoney(res);
      }
    }, stepMs);
  }

  async function settlePlaymoney(res) {
    try {
      const out = await API.confirmDeposit({ depositId: res.depositId });
      // Server returns the new balance; api.js already applies progression deltas.
      if (typeof out.balance === 'number' && global.Bankroll) Bankroll.set(out.balance);
      Toast.win(`+${fmtCrypt(out.funCredited)} CRYPT deposited`);
      if (out.funCredited >= 100 && global.Confetti) Confetti.burst({ count: 120 });
      $('vaultDone').classList.remove('hidden');
      $('vaultCancel').classList.add('hidden');
      renderHistory();
    } catch (e) {
      Toast.error(e.message || 'Settlement failed');
    }
  }

  function startPolling(depositId, funCredited) {
    stopPolling();
    pollTimer = setInterval(async () => {
      try {
        const out = await API.listDeposits(50);
        const row = (out.deposits || []).find(d => d.id === depositId);
        if (!row) return;
        if (row.status === 'completed') {
          stopPolling();
          if (global.Bankroll) {
            // Pull authoritative balance.
            try { const me = await API.me(); if (me.user) Bankroll.set(me.user.balance); } catch (e) {}
          }
          confirmsNow = confirmsRequired;
          $('vaultConfirmNow').textContent = confirmsNow;
          $('vaultConfirmFill').style.width = '100%';
          Toast.win(`+${fmtCrypt(funCredited)} CRYPT confirmed`);
          if (funCredited >= 100 && global.Confetti) Confetti.burst({ count: 120 });
          $('vaultDone').classList.remove('hidden');
          $('vaultCancel').classList.add('hidden');
          renderHistory();
        } else if (row.status === 'cancelled') {
          stopPolling();
          Toast.warn('Deposit cancelled');
          showCreateForm();
        }
      } catch (e) {}
    }, 5000);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function cancel() {
    if (!pendingDepositId) { showCreateForm(); return; }
    try {
      await API.cancelDeposit({ depositId: pendingDepositId });
      Toast.info('Deposit cancelled');
    } catch (e) { /* may already be settled — fine */ }
    stopPolling();
    pendingDepositId = null;
    showCreateForm();
    refreshSnapshot();
    renderHistory();
  }

  async function renderHistory() {
    try {
      const out = await API.listDeposits(50);
      const list = $('vaultHistoryList');
      if (!out.deposits || !out.deposits.length) {
        list.innerHTML = '<li class="feed-empty">No deposits yet.</li>';
        return;
      }
      list.innerHTML = out.deposits.map(d => {
        const when = new Date(d.ts).toLocaleString();
        const cls = d.status === 'completed' ? 'win' : (d.status === 'cancelled' ? 'loss' : '');
        return `<li class="vh-row ${cls}">
          <span class="vh-currency">${d.currency}</span>
          <span class="vh-amount">${d.amount}</span>
          <span class="vh-fun">+${fmtCrypt(d.funCredited)} CRYPT</span>
          <span class="vh-status">${d.status}</span>
          <span class="vh-txid muted" title="${d.txid || ''}">${truncate(d.txid || '', 10)}</span>
          <span class="vh-when muted">${when}</span>
        </li>`;
      }).join('');
    } catch (e) {}
  }

  function wire() {
    modal = $('vaultModal');
    if (!modal) return;
    $('btnDeposit').addEventListener('click', open);
    $('vaultClose').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    document.querySelectorAll('.vault-tab').forEach(t => t.addEventListener('click', () => showPane(t.dataset.vtab)));
    $('vaultAmount').addEventListener('input', syncPreview);
    $('vaultCreate').addEventListener('click', createDeposit);
    $('vaultCopy').addEventListener('click', async () => {
      const ok = await safeCopy($('vaultAddress').textContent);
      Toast[ok ? 'info' : 'warn'](ok ? 'Address copied' : 'Copy failed — long-press to copy manually');
    });
    $('vaultCancel').addEventListener('click', cancel);
    $('vaultDone').addEventListener('click', () => {
      pendingDepositId = null;
      $('vaultCancel').classList.remove('hidden');
      showCreateForm();
      refreshSnapshot();
    });
  }

  global.Vault = { wire, open };
})(window);
