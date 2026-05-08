/* Crash game.
 * Each round: provably-fair bust multiplier is sampled at the start.
 * The displayed multiplier rises along the curve m(t) = 1.0024^t  (per ms),
 * ≈ 1x doubling every ~290ms. Player can cash out any time before bust.
 */
(function (global) {
  'use strict';

  // Smooth exponential rise; with base 1.13 per second this gives
  // 1.5×≈3.3s, 2×≈5.7s, 5×≈13.2s, 10×≈18.9s.
  const BASE = 1.13;
  function multAt(elapsedMs) {
    return Math.pow(BASE, elapsedMs / 1000);
  }

  function mountCrash(container) {
    container.innerHTML = `
      <div class="game-grid">
        <div class="controls">
          <div class="field">
            <label>Bet Amount <span id="cBetUsd" class="muted">USD</span></label>
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
            <div class="stat"><span class="stat-label">Profit on Win</span><span class="stat-value" id="cProfit">0.00</span></div>
            <div class="stat"><span class="stat-label">Last Crash</span><span class="stat-value" id="cLast">—</span></div>
          </div>
          <div class="divider"></div>
          <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">
            Watch the multiplier climb. Cash out before it crashes — or set an auto-cashout target. House edge 1%.
          </p>
        </div>
        <div class="stage crash-stage">
          <canvas class="crash-canvas" id="cCanvas"></canvas>
          <div class="crash-history" id="cHistory"></div>
          <div class="crash-multiplier" id="cMult">1.00×</div>
          <div class="crash-status" id="cStatus">Place a bet to begin</div>
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
      lastEl.textContent = pastCrashes.length ? pastCrashes[pastCrashes.length-1].toFixed(2) + '×' : '—';
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

    // ---- Round state ----
    const STATE = { IDLE: 0, RUNNING: 1, CASHED: 2, CRASHED: 3 };
    let state = STATE.IDLE;
    let bet = 0;
    let bustAt = 0;
    let cashedAt = 0;
    let startMs = 0;
    let raf = null;
    let curr = 1;

    function setStatus(text) { statusEl.textContent = text; }
    function fmt(n) { return n.toFixed(2); }

    function updateProfit() {
      const b = +betInput.value || 0;
      const a = +autoInput.value || 0;
      profitEl.textContent = fmt(Math.max(0, b * (a - 1)));
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

    function placeBet() {
      const amount = +betInput.value;
      if (!amount || amount <= 0) return Toast.warn('Enter a bet amount');
      if (!Bankroll.canAfford(amount)) return Toast.error('Insufficient balance');
      Bankroll.add(-amount);
      bet = amount;
      const sample = Fair.sampleCrash();
      bustAt = sample.mult;
      Fair.recordRoll({
        game: 'crash', nonce: sample.fair.nonce, hash: sample.fair.hash,
        result: bustAt.toFixed(2) + '×', ts: Date.now()
      });
      startMs = performance.now();
      cashedAt = 0;
      state = STATE.RUNNING;
      multEl.classList.remove('crashed','cashed');
      multEl.style.color = '';
      setStatus('In flight — cash out before it crashes');
      actionBtn.textContent = 'Cash Out';
      actionBtn.classList.remove('btn-primary');
      actionBtn.classList.add('btn-danger');
      betInput.disabled = true;
      autoInput.disabled = true;
      tick();
    }

    function cashOut() {
      if (state !== STATE.RUNNING) return;
      cashedAt = curr;
      state = STATE.CASHED;
      const payout = bet * cashedAt;
      Bankroll.add(payout);
      multEl.classList.add('cashed');
      setStatus(`Cashed out at ${fmt(cashedAt)}× — won ${Bankroll.fmt(payout - bet)}`);
      Toast.win(`+${Bankroll.fmt(payout - bet)} @ ${fmt(cashedAt)}×`);
      Feed.recordPlayerBet({ game: 'crash', bet, mult: cashedAt, win: true, payout });
      // Continue rendering until bust so player sees what would have been
    }

    function endRound() {
      const wasCashed = state === STATE.CASHED;
      pastCrashes.push(bustAt);
      saveHistory();
      renderHistory();
      if (!wasCashed && bet > 0) {
        multEl.classList.add('crashed');
        setStatus(`Crashed at ${fmt(bustAt)}× — lost ${Bankroll.fmt(bet)}`);
        Feed.recordPlayerBet({ game: 'crash', bet, mult: 0, win: false, payout: 0 });
      } else if (!bet) {
        setStatus(`Crashed at ${fmt(bustAt)}× — next round in 4s`);
      }
      bet = 0;
      state = STATE.CRASHED;
      actionBtn.textContent = 'Next Round…';
      actionBtn.disabled = true;
      actionBtn.classList.remove('btn-danger');
      actionBtn.classList.add('btn-primary');
      // Auto-restart the spectator round in 4s
      setTimeout(() => {
        if (!alive) return;
        actionBtn.textContent = 'Place Bet';
        actionBtn.disabled = false;
        betInput.disabled = false;
        autoInput.disabled = false;
        state = STATE.IDLE;
        multEl.classList.remove('crashed','cashed');
        curr = 1;
        multEl.textContent = '1.00×';
        drawIdle();
        setStatus('Place a bet to begin');
      }, 1800);
    }

    function tick() {
      if (state !== STATE.RUNNING && state !== STATE.CASHED) return;
      const elapsed = performance.now() - startMs;
      curr = multAt(elapsed);
      // Auto cashout
      if (state === STATE.RUNNING) {
        const auto = +autoInput.value;
        if (auto > 1 && curr >= auto && bet > 0) {
          curr = auto;
          cashOut();
        }
      }
      if (curr >= bustAt) {
        curr = bustAt;
        multEl.textContent = fmt(curr) + '×';
        draw(elapsed, curr);
        endRound();
        return;
      }
      multEl.textContent = fmt(curr) + '×';
      draw(elapsed, curr);
      raf = requestAnimationFrame(tick);
    }

    // ---- Drawing ----
    function drawIdle() {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);
      drawGrid(w, h, 1);
    }

    function drawGrid(w, h, maxMult) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const rows = 6, cols = 8;
      for (let i = 1; i < rows; i++) {
        const y = (h * i) / rows;
        ctx.moveTo(0, y); ctx.lineTo(w, y);
      }
      for (let i = 1; i < cols; i++) {
        const x = (w * i) / cols;
        ctx.moveTo(x, 0); ctx.lineTo(x, h);
      }
      ctx.stroke();
      ctx.restore();
    }

    function draw(elapsedMs, mult) {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);
      drawGrid(w, h, mult);

      // Map elapsed time onto x, multiplier onto y, with view that grows
      // so the curve always fits the screen.
      const viewMs = Math.max(6000, elapsedMs * 1.15);
      const viewMax = Math.max(2, mult * 1.15);

      const padL = 36, padR = 12, padT = 18, padB = 32;
      const cw = Math.max(1, w - padL - padR);
      const ch = Math.max(1, h - padT - padB);
      const xAt = t => padL + (t / viewMs) * cw;
      const yAt = m => padT + ch - (Math.log(m) / Math.log(viewMax)) * ch;

      // Y-axis multiplier labels
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'right';
      const stops = [1, 1.5, 2, 5, 10, 25, 100];
      stops.forEach(s => {
        if (s > viewMax) return;
        const y = yAt(s);
        ctx.fillText(s + '×', padL - 6, y + 4);
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(w - padR, y);
        ctx.stroke();
      });
      ctx.restore();

      // Curve
      const steps = 80;
      ctx.save();
      const grad = ctx.createLinearGradient(0, padT, 0, padT + ch);
      grad.addColorStop(0, 'rgba(0,230,118,0.45)');
      grad.addColorStop(1, 'rgba(0,230,118,0.0)');
      ctx.beginPath();
      ctx.moveTo(padL, padT + ch);
      for (let i = 0; i <= steps; i++) {
        const t = (elapsedMs * i) / steps;
        const m = multAt(t);
        ctx.lineTo(xAt(t), yAt(m));
      }
      ctx.lineTo(xAt(elapsedMs), padT + ch);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = state === STATE.CRASHED ? 'rgba(255,77,109,0.95)' :
                        state === STATE.CASHED ? 'rgba(245,197,66,0.95)' :
                        'rgba(0,230,118,0.95)';
      ctx.shadowColor = ctx.strokeStyle;
      ctx.shadowBlur = 18;
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const t = (elapsedMs * i) / steps;
        const m = multAt(t);
        const x = xAt(t), y = yAt(m);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();

      // Rocket head
      const hx = xAt(elapsedMs), hy = yAt(mult);
      ctx.save();
      ctx.translate(hx, hy);
      ctx.fillStyle = '#fff';
      ctx.shadowColor = 'rgba(0,230,118,0.9)';
      ctx.shadowBlur = 24;
      ctx.beginPath();
      ctx.arc(0, 0, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    drawIdle();

    // ---- Action button ----
    actionBtn.addEventListener('click', () => {
      if (state === STATE.IDLE) placeBet();
      else if (state === STATE.RUNNING) cashOut();
    });

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
