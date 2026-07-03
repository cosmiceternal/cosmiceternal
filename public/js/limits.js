/* Responsible gaming client. Loss limit + self-exclusion talk to the server
 * (which enforces them in the wager path); the reality check is a local
 * 30-minute timer that reports session time and net result. */
(function (global) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const CHECK_MS = 30 * 60 * 1000;
  let modal = null, checkTimer = null, sessionStart = 0, startBalance = 0;

  async function refresh() {
    try {
      const s = await API.limits();
      $('lossLimitStatus').textContent = s.lossLimit
        ? `Current limit: ${Bankroll.fmt(s.lossLimit)} CRYPT — net loss today ${Bankroll.fmt(s.netLossToday)} CRYPT.`
        : 'No loss limit set.';
      $('excludeStatus').textContent = s.excludedUntil
        ? `Self-exclusion active until ${new Date(s.excludedUntil).toLocaleString()}.`
        : 'Not excluded.';
      // While excluded, the buttons stay visible but the server refuses —
      // still grey them for honesty.
      document.querySelectorAll('[data-exclude]').forEach(b => b.disabled = !!s.excludedUntil);
    } catch (e) { Toast.error(e.message); }
  }

  function open() { modal.classList.remove('hidden'); refresh(); }
  function close() { modal.classList.add('hidden'); }

  function startRealityCheck() {
    stopRealityCheck();
    let enabled = true;
    try { enabled = localStorage.getItem('crypt.realitycheck') !== '0'; } catch (_) {}
    const toggle = $('realityCheckToggle');
    if (toggle) toggle.checked = enabled;
    if (!enabled) return;
    checkTimer = setInterval(() => {
      const mins = Math.round((Date.now() - sessionStart) / 60000);
      const net = Bankroll.get() - startBalance;
      const sign = net >= 0 ? '+' : '−';
      Toast.info(`⏱️ You've been playing ${mins} min. Session: ${sign}${Bankroll.fmt(Math.abs(net))} CRYPT.`);
    }, CHECK_MS);
  }
  function stopRealityCheck() { if (checkTimer) { clearInterval(checkTimer); checkTimer = null; } }

  function wire(user) {
    modal = $('limitsModal');
    if (!modal) return;
    sessionStart = Date.now();
    startBalance = user ? user.balance : Bankroll.get();

    $('btnLimits').addEventListener('click', () => { open(); });
    $('limitsClose').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

    $('lossLimitSet').addEventListener('click', async () => {
      const v = Number($('lossLimitInput').value);
      if (!isFinite(v) || v < 1) { Toast.warn('Enter a limit in CRYPT'); return; }
      try { await API.setLossLimit(v); Toast.info('Loss limit set'); refresh(); }
      catch (e) { Toast.error(e.message); }
    });
    $('lossLimitClear').addEventListener('click', async () => {
      try { await API.setLossLimit(null); Toast.info('Loss limit removed'); refresh(); }
      catch (e) { Toast.error(e.message); }
    });
    document.querySelectorAll('[data-exclude]').forEach(b => b.addEventListener('click', async () => {
      const days = Number(b.dataset.exclude);
      // A real confirm — this cannot be undone early.
      if (!global.confirm(`Self-exclude for ${days} day${days === 1 ? '' : 's'}? Wagering and deposits lock immediately and this CANNOT be reversed early.`)) return;
      try { await API.selfExclude(days); Toast.info('Self-exclusion active. Take care of yourself.'); refresh(); }
      catch (e) { Toast.error(e.message); }
    }));
    $('realityCheckToggle').addEventListener('change', (e) => {
      try { localStorage.setItem('crypt.realitycheck', e.target.checked ? '1' : '0'); } catch (_) {}
      if (e.target.checked) startRealityCheck(); else stopRealityCheck();
    });

    startRealityCheck();
  }

  global.Limits = { wire, open };
})(window);
