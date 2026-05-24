/* Crash — you set a bet and an auto-cashout target. The server settles the
 * round atomically (win at your target if the bust point reaches it, else
 * loss) and returns the bust. The client then animates the rocket climbing to
 * either your target (cash out, gold) or the bust point (crash, red). */
(function (global) {
  'use strict';

  const BASE = 1.13;
  const multAt = (ms) => Math.pow(BASE, ms / 1000);

  function mountCrash(container) {
    container.innerHTML = `
      <div class="game-grid">
        <div class="controls">
          <div class="field">
            <label>Bet Amount <span class="muted">FUN</span></label>
            <div class="bet-row">
              <input id="cBet" type="number" min="0.01" step="0.01" value="1.00" />
              <button class="btn" data-act="half">½</button>
              <button class="btn" data-act="dbl">2×</button>
              <button class="btn" data-act="max">Max</button>
            </div>
          </div>
          <div class="field">
            <label>Auto Cashout <span class="muted">×</span></label>
            <input id="cAuto" type="number" min="1.01" step="0.01" value="2.00" />
          </div>
          <div class="divider"></div>
          <button class="btn btn-primary btn-block" id="cAction">Place Bet</button>
          <div class="stat-grid">
            <div class="stat"><span class="stat-label">Profit on Win</span><span class="stat-value" id="cProfit">1.00</span></div>
            <div class="stat"><span class="stat-label">Last Crash</span><span class="stat-value" id="cLast">—</span></div>
          </div>
          <div class="divider"></div>
          <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">
            Will the rocket reach your auto-cashout before it busts? Outcome is settled and provably fair the instant you bet.
          </p>
        </div>
        <div class="stage crash-stage">
          <canvas class="crash-canvas" id="cCanvas"></canvas>
          <div class="crash-history" id="cHistory"></div>
          <div class="crash-multiplier" id="cMult">1.00×</div>
          <div class="crash-status" id="cStatus">Set a target and place a bet</div>
        </div>
      </div>
    `;

    const canvas = container.querySelector('#cCanvas');
    const ctx = canvas.getContext('2d');
    const multEl = container.querySelector('#cMult');
    const statusEl = container.querySelector('#cStatus');
    const actionBtn = container.querySelector('#cAction');
    const betInput = container.querySelector('#cBet');
    const autoInput = container.querySelector('#cAuto');
    const profitEl = container.querySelector('#cProfit');
    const lastEl = container.querySelector('#cLast');
    const historyEl = container.querySelector('#cHistory');

    const pastCrashes = JSON.parse(localStorage.getItem('neonstake.crash.history') || '[]');
    function saveHistory() {
      try { localStorage.setItem('neonstake.crash.history', JSON.stringify(pastCrashes.slice(-30))); } catch (e) {}
    }
    function renderHistory() {
      historyEl.innerHTML = '';
      pastCrashes.slice(-12).reverse().forEach(m => {
        const chip = document.createElement('span');
        chip.className = 'crash-chip ' + (m < 1.5 ? 'lo' : m < 5 ? 'md' : 'hi');
        chip.textContent = m.toFixed(2) + '×';
        historyEl.appendChild(chip);
      });
      lastEl.textContent = pastCrashes.length ? pastCrashes[pastCrashes.length - 1].toFixed(2) + '×' : '—';
    }
    renderHistory();

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const r = canvas.getBoundingClientRect();
      canvas.width = r.width * dpr;
      canvas.height = r.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    function updateProfit() {
      const b = +betInput.value || 0;
      const a = +autoInput.value || 0;
      profitEl.textContent = Math.max(0, b * (a - 1)).toFixed(2);
    }
    updateProfit();
    betInput.addEventListener('input', updateProfit);
    autoInput.addEventListener('input', updateProfit);

    container.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        let v = +betInput.value || 0;
        if (act === 'half') v = v / 2;
        else if (act === 'dbl') v = v * 2;
        else if (act === 'max') v = Bankroll.get();
        betInput.value = Math.max(0.01, +v.toFixed(2));
        updateProfit();
      });
    });

    let running = false;
    let raf = null;

    async function placeBet() {
      if (running) return;
      const bet = +betInput.value;
      const target = +autoInput.value;
      if (!bet || bet <= 0) return Toast.warn('Enter a bet amount');
      if (!target || target < 1.01) return Toast.warn('Auto cashout must be at least 1.01×');
      if (!Bankroll.canAfford(bet)) return Toast.error('Insufficient balance');

      actionBtn.disabled = true;
      const preBalance = Bankroll.get();
      let res;
      try {
        res = await API.crash({ bet, autoCashout: target });
      } catch (e) { Toast.error(e.message); actionBtn.disabled = false; return; }
      // Show the bet leaving the balance now; credit any winnings when the
      // rocket actually reaches the cashout point (in settle()).
      Bankroll.set(preBalance - bet);
      Fair.bumpNonce();

      running = true;
      betInput.disabled = true;
      autoInput.disabled = true;
      multEl.classList.remove('crashed', 'cashed');
      const stop = res.win ? res.target : res.bust;
      animate(stop, res, bet);
    }

    function animate(stop, res, bet) {
      const startMs = performance.now();
      multEl.textContent = '1.00×';
      statusEl.textContent = 'In flight…';

      function tick() {
        const elapsed = performance.now() - startMs;
        let curr = multAt(elapsed);
        if (curr >= stop) {
          curr = stop;
          multEl.textContent = curr.toFixed(2) + '×';
          draw(elapsed, curr, res.win);
          settle(res, bet);
          return;
        }
        multEl.textContent = curr.toFixed(2) + '×';
        draw(elapsed, curr, null);
        raf = requestAnimationFrame(tick);
      }
      tick();
    }

    function settle(res, bet) {
      Bankroll.set(res.balance); // authoritative final balance (credits winnings on a win)
      pastCrashes.push(res.bust);
      saveHistory();
      renderHistory();
      if (res.win) {
        multEl.classList.add('cashed');
        statusEl.textContent = `Cashed out at ${res.target.toFixed(2)}× — won ${Bankroll.fmt(res.payout - bet)}`;
        Toast.win(`+${Bankroll.fmt(res.payout - bet)} @ ${res.target.toFixed(2)}×`);
      } else {
        multEl.classList.add('crashed');
        multEl.textContent = res.bust.toFixed(2) + '×';
        statusEl.textContent = `Crashed at ${res.bust.toFixed(2)}× — lost ${Bankroll.fmt(bet)}`;
        Toast.loss(`Crashed at ${res.bust.toFixed(2)}× — lost ${Bankroll.fmt(bet)}`);
      }
      Feed.recordPlayerBet({ game: 'crash', bet, mult: res.win ? res.target : 0, win: res.win, payout: res.payout });

      setTimeout(() => {
        if (!alive) return;
        running = false;
        actionBtn.disabled = false;
        betInput.disabled = false;
        autoInput.disabled = false;
        multEl.classList.remove('crashed', 'cashed');
        multEl.textContent = '1.00×';
        statusEl.textContent = 'Set a target and place a bet';
        drawIdle();
      }, 2000);
    }

    function drawIdle() {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);
      drawGrid(w, h);
    }
    function drawGrid(w, h) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 1; i < 6; i++) { const y = (h * i) / 6; ctx.moveTo(0, y); ctx.lineTo(w, y); }
      for (let i = 1; i < 8; i++) { const x = (w * i) / 8; ctx.moveTo(x, 0); ctx.lineTo(x, h); }
      ctx.stroke();
      ctx.restore();
    }

    function draw(elapsedMs, mult, win) {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);
      drawGrid(w, h);
      const viewMs = Math.max(6000, elapsedMs * 1.15);
      const viewMax = Math.max(2, mult * 1.15);
      const padL = 36, padR = 12, padT = 18, padB = 32;
      const cw = Math.max(1, w - padL - padR);
      const ch = Math.max(1, h - padT - padB);
      const xAt = t => padL + (t / viewMs) * cw;
      const yAt = m => padT + ch - (Math.log(m) / Math.log(viewMax)) * ch;

      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'right';
      [1, 1.5, 2, 5, 10, 25, 100].forEach(s => {
        if (s > viewMax) return;
        const y = yAt(s);
        ctx.fillText(s + '×', padL - 6, y + 4);
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      });
      ctx.restore();

      const steps = 80;
      const color = win === false ? 'rgba(255,77,109,0.95)' : win === true ? 'rgba(245,197,66,0.95)' : 'rgba(0,230,118,0.95)';
      const grad = ctx.createLinearGradient(0, padT, 0, padT + ch);
      grad.addColorStop(0, win === false ? 'rgba(255,77,109,0.4)' : 'rgba(0,230,118,0.45)');
      grad.addColorStop(1, 'rgba(0,230,118,0.0)');
      ctx.beginPath();
      ctx.moveTo(padL, padT + ch);
      for (let i = 0; i <= steps; i++) { const t = (elapsedMs * i) / steps; ctx.lineTo(xAt(t), yAt(multAt(t))); }
      ctx.lineTo(xAt(elapsedMs), padT + ch);
      ctx.closePath();
      ctx.fillStyle = grad; ctx.fill();

      ctx.lineWidth = 3;
      ctx.strokeStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 18;
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const t = (elapsedMs * i) / steps;
        const x = xAt(t), y = yAt(multAt(t));
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();

      const hx = xAt(elapsedMs), hy = yAt(mult);
      ctx.save();
      ctx.translate(hx, hy);
      ctx.fillStyle = '#fff';
      ctx.shadowColor = color;
      ctx.shadowBlur = 24;
      ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    drawIdle();
    actionBtn.addEventListener('click', placeBet);

    let alive = true;
    return function unmount() {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }

  global.Games = global.Games || {};
  global.Games.crash = mountCrash;
})(window);
