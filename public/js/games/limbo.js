/* Limbo — pick a target multiplier; the server rolls. Win if it reaches it. */
(function (global) {
  'use strict';
  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('lBet')}
      <div class="field">
        <label>Target Multiplier <span id="lWin" class="muted">50.00%</span></label>
        <input id="lTarget" type="number" min="1.01" step="0.01" value="2.00" />
      </div>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Win Chance</span><span class="stat-value" id="lChance">49.50%</span></div>
        <div class="stat"><span class="stat-label">Payout</span><span class="stat-value" id="lPay">2.00×</span></div>
      </div>
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="lAction">Place Bet</button>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">The higher your target, the rarer the win — 1% house edge at every target.</p>
    `, `<div class="limbo-result" id="lResult">1.00×</div>
        <div class="crash-status" id="lStatus">Set a target and roll</div>`, 'limbo-stage');

    const betInput = container.querySelector('#lBet');
    const target = container.querySelector('#lTarget');
    const action = container.querySelector('#lAction');
    const resultEl = container.querySelector('#lResult');
    const statusEl = container.querySelector('#lStatus');
    let busy = false, alive = true, raf = null;

    function stats() {
      const t = Math.max(1.01, +target.value || 1.01);
      const chance = 99 / t;
      container.querySelector('#lChance').textContent = chance.toFixed(2) + '%';
      container.querySelector('#lWin').textContent = chance.toFixed(2) + '%';
      container.querySelector('#lPay').textContent = t.toFixed(2) + '×';
    }
    target.addEventListener('input', stats);
    GameKit.wireBet(container, betInput);
    stats();

    function animateTo(value, win) {
      const start = performance.now();
      const dur = 600;
      function tick(now) {
        const p = Math.min(1, (now - start) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        const shown = 1 + (value - 1) * eased;
        resultEl.textContent = shown.toFixed(2) + '×';
        if (p < 1 && alive) raf = requestAnimationFrame(tick);
        else {
          resultEl.textContent = value.toFixed(2) + '×';
          resultEl.className = 'limbo-result ' + (win ? 'win' : 'loss');
        }
      }
      raf = requestAnimationFrame(tick);
    }

    async function play() {
      if (busy) return;
      const b = GameKit.bet(betInput);
      if (b == null) return;
      const t = +target.value;
      if (!t || t < 1.01) return Toast.warn('Target must be at least 1.01×');
      busy = true; action.disabled = true;
      resultEl.className = 'limbo-result';
      try {
        const res = await API.limbo({ bet: b, target: t });
        animateTo(res.result, res.win);
        statusEl.textContent = res.win
          ? `Rolled ${res.result.toFixed(2)}× — beat ${t.toFixed(2)}×`
          : `Rolled ${res.result.toFixed(2)}× — needed ${t.toFixed(2)}×`;
        GameKit.settle('limbo', b, res);
      } catch (e) { Toast.error(e.message); }
      finally { busy = false; action.disabled = false; }
    }
    action.addEventListener('click', play);
    return function () { alive = false; if (raf) cancelAnimationFrame(raf); };
  }
  global.Games = global.Games || {};
  global.Games.limbo = mount;
})(window);
