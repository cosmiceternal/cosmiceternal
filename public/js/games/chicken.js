/* Chicken Road — hop across lanes of traffic. Each hop survives with the
 * difficulty's probability; multiplier compounds per lane. Cash out any
 * time. Server-authoritative: every hop is a fair-stream draw. */
(function (global) {
  'use strict';
  const DIFFS = [
    { key: 'easy',      label: 'Easy',      desc: '24 lanes · gentle traffic' },
    { key: 'medium',    label: 'Medium',    desc: '20 lanes · brisk traffic' },
    { key: 'hard',      label: 'Hard',      desc: '16 lanes · rush hour' },
    { key: 'daredevil', label: 'Daredevil', desc: '12 lanes · death wish' }
  ];
  const SHOW_LANES = 10; // window of lanes visible at once

  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('chBet')}
      <div class="field">
        <label>Difficulty</label>
        <select id="chDiff" class="game-select">
          ${DIFFS.map(d => `<option value="${d.key}">${d.label} — ${d.desc}</option>`).join('')}
        </select>
      </div>
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="chStart">Start Crossing</button>
      <div class="row hidden" id="chActions">
        <button class="btn btn-primary" id="chHop" style="flex:1">Hop 🐔</button>
        <button class="btn" id="chCash" style="flex:1">Cash Out</button>
      </div>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Multiplier</span><span class="stat-value" id="chMult">—</span></div>
        <div class="stat"><span class="stat-label">Next</span><span class="stat-value" id="chNext">—</span></div>
      </div>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">Every lane multiplies your bet. Get hit and lose it all. Clear the whole road for the max payout.</p>
    `, `<div class="chicken-road" id="chRoad"></div>
        <div class="crash-status" id="chStatus">Pick a difficulty and start.</div>`, 'chicken-stage');

    const betInput = container.querySelector('#chBet');
    const diffSel = container.querySelector('#chDiff');
    const startBtn = container.querySelector('#chStart');
    const actions = container.querySelector('#chActions');
    const hopBtn = container.querySelector('#chHop');
    const cashBtn = container.querySelector('#chCash');
    const road = container.querySelector('#chRoad');
    const multEl = container.querySelector('#chMult');
    const nextEl = container.querySelector('#chNext');
    const statusEl = container.querySelector('#chStatus');
    let roundId = null, busy = false, step = 0, lanes = 0, stake = 0;
    GameKit.wireBet(container, betInput);

    function renderRoad() {
      // Sliding window: keep the chicken near the left once past mid-window.
      const offset = Math.max(0, Math.min(step - 3, lanes - SHOW_LANES + 1));
      let html = '';
      for (let i = offset; i <= Math.min(lanes, offset + SHOW_LANES - 1); i++) {
        const cls = i === 0 ? 'start' : (i <= step ? 'crossed' : 'ahead');
        const label = i === 0 ? '🏁' : (i === step && step > 0 ? '🐔' : (i === lanes ? '🏆' : '🚗'));
        html += `<div class="ch-lane ${cls}" data-lane="${i}"><span class="ch-lane-icon">${label}</span><span class="ch-lane-n">${i > 0 ? i : ''}</span></div>`;
      }
      road.innerHTML = html;
    }
    function idle() {
      roundId = null; busy = false; step = 0;
      actions.classList.add('hidden');
      startBtn.classList.remove('hidden');
      startBtn.disabled = false;
      betInput.disabled = false; diffSel.disabled = false;
    }

    startBtn.addEventListener('click', async () => {
      if (busy || roundId) return;
      const b = GameKit.bet(betInput);
      if (b == null) return;
      busy = true; startBtn.disabled = true;
      try {
        const res = await API.chickenStart({ bet: b, difficulty: diffSel.value });
        Fair.bumpNonce();
        Bankroll.set(res.balance);
        roundId = res.roundId; stake = b; step = 0; lanes = res.lanes;
        startBtn.classList.add('hidden');
        actions.classList.remove('hidden');
        betInput.disabled = true; diffSel.disabled = true;
        multEl.textContent = '1.00×';
        nextEl.textContent = res.nextMult.toFixed(2) + '×';
        statusEl.textContent = 'Hop when ready — traffic is live.';
        renderRoad();
        busy = false;
      } catch (e) { Toast.error(e.message); idle(); }
    });

    hopBtn.addEventListener('click', async () => {
      if (busy || !roundId) return;
      busy = true;
      try {
        const res = await API.chickenStep({ roundId });
        Fair.bumpNonce();
        if (res.hit) {
          step = res.step;
          renderRoad();
          const hitLane = road.querySelector(`[data-lane="${step}"]`);
          if (hitLane) { hitLane.classList.add('hit'); hitLane.querySelector('.ch-lane-icon').textContent = '💥'; }
          statusEl.textContent = 'Splat. The road wins this one.';
          Bankroll.set(res.balance);
          Feed.recordPlayerBet({ game: 'chicken', bet: stake, mult: 0, win: false, payout: 0 });
          if (global.Sound) Sound.play('loss');
          Toast.loss(`−${Bankroll.fmt(stake)}`);
          idle();
          return;
        }
        step = res.step;
        renderRoad();
        if (global.Sound) Sound.play('climb', { n: res.step });
        if (res.cleared) {
          Bankroll.set(res.balance);
          statusEl.textContent = `Road cleared! ${res.mult.toFixed(2)}×`;
          Feed.recordPlayerBet({ game: 'chicken', bet: stake, mult: res.mult, win: true, payout: res.payout });
          if (global.Sound) Sound.play(res.mult >= 10 ? 'bigwin' : 'win');
          GameKit.flashWin();
          Toast.win(`+${Bankroll.fmt(res.payout - stake)} @ ${res.mult.toFixed(2)}×`);
          if (res.mult >= 10 && global.Confetti) Confetti.burst({ count: 120 });
          idle();
          return;
        }
        multEl.textContent = res.mult.toFixed(2) + '×';
        nextEl.textContent = res.nextMult.toFixed(2) + '×';
        cashBtn.textContent = `Cash Out ${Bankroll.fmt(res.cashout)}`;
        statusEl.textContent = `Lane ${step} of ${lanes} crossed.`;
        busy = false;
      } catch (e) { Toast.error(e.message); busy = false; }
    });

    cashBtn.addEventListener('click', async () => {
      if (busy || !roundId) return;
      busy = true;
      try {
        const res = await API.chickenCashout({ roundId });
        Bankroll.set(res.balance);
        statusEl.textContent = `Cashed out at ${res.mult.toFixed(2)}×.`;
        Feed.recordPlayerBet({ game: 'chicken', bet: stake, mult: res.mult, win: true, payout: res.payout });
        if (global.Sound) Sound.play('cashout');
        GameKit.flashWin();
        Toast.win(`+${Bankroll.fmt(res.payout - stake)} @ ${res.mult.toFixed(2)}×`);
        if (res.mult >= 10 && global.Confetti) Confetti.burst({ count: 100 });
        idle();
      } catch (e) { Toast.error(e.message); busy = false; }
    });

    renderRoad();
    return function () {};
  }
  global.Games = global.Games || {};
  global.Games.chicken = mount;
})(window);
