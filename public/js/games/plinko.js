/* Plinko — the server picks the ball's left/right path and pays out; the
 * client animates the ball along exactly that path. */
(function (global) {
  'use strict';

  // Payout tables mirror the server (server is authoritative for payout).
  const SLOTS = {
    8:  { low:  [5.6, 2.1, 1.1, 1.0, 0.5, 1.0, 1.1, 2.1, 5.6],
          mid:  [13, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 13],
          high: [29, 4, 1.5, 0.3, 0.2, 0.3, 1.5, 4, 29] },
    12: { low:  [10, 3, 1.6, 1.4, 1.1, 1.0, 0.5, 1.0, 1.1, 1.4, 1.6, 3, 10],
          mid:  [33, 11, 4, 2, 1.1, 0.6, 0.3, 0.6, 1.1, 2, 4, 11, 33],
          high: [76, 18, 7, 2, 0.7, 0.2, 0.2, 0.2, 0.7, 2, 7, 18, 76] },
    16: { low:  [16, 9, 2, 1.4, 1.4, 1.2, 1.1, 1.0, 0.5, 1.0, 1.1, 1.2, 1.4, 1.4, 2, 9, 16],
          mid:  [110, 41, 10, 5, 3, 1.5, 1.0, 0.5, 0.3, 0.5, 1.0, 1.5, 3, 5, 10, 41, 110],
          high: [1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 9, 26, 130, 1000] }
  };

  function colorForMult(m) {
    if (m >= 10) return ['#ff5277', '#ffb3c5'];
    if (m >= 2)  return ['#f5c542', '#ffe9a8'];
    if (m >= 1)  return ['#00e676', '#aaffcc'];
    return ['#3b4756', '#7a8a9a'];
  }

  function mountPlinko(container) {
    container.innerHTML = `
      <div class="game-grid">
        <div class="controls">
          <div class="field">
            <label>Bet Amount <span class="muted">CRYPT</span></label>
            <div class="bet-row">
              <input id="pBet" type="number" min="0.01" step="0.01" value="1.00" />
              <button class="btn" data-act="half">½</button>
              <button class="btn" data-act="dbl">2×</button>
              <button class="btn" data-act="max">Max</button>
            </div>
          </div>
          <div class="field">
            <label>Risk</label>
            <div class="toggle" id="pRisk">
              <button class="active" data-risk="low">Low</button>
              <button data-risk="mid">Medium</button>
              <button data-risk="high">High</button>
            </div>
          </div>
          <div class="field">
            <label>Rows</label>
            <div class="toggle" id="pRows">
              <button data-rows="8">8</button>
              <button class="active" data-rows="12">12</button>
              <button data-rows="16">16</button>
            </div>
          </div>
          <div class="divider"></div>
          <button class="btn btn-primary btn-block" id="pAction">Drop Ball</button>
          <div class="field">
            <label>Auto-drop</label>
            <div class="bet-row">
              <input id="pAutoCount" type="number" min="0" max="100" value="0" placeholder="0 = off" />
              <button class="btn" id="pAutoStop">Stop</button>
            </div>
          </div>
          <div class="divider"></div>
          <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">
            The ball's path is chosen by the server's provably-fair draw. Higher risk widens the edge multipliers.
          </p>
        </div>
        <div class="stage plinko-stage">
          <canvas class="plinko-canvas" id="pCanvas"></canvas>
          <div class="plinko-multipliers" id="pMults"></div>
        </div>
      </div>
    `;

    const canvas = container.querySelector('#pCanvas');
    const ctx = canvas.getContext('2d');
    const multsEl = container.querySelector('#pMults');
    const actionBtn = container.querySelector('#pAction');
    const betInput = container.querySelector('#pBet');
    const riskBtns = container.querySelectorAll('#pRisk button');
    const rowsBtns = container.querySelectorAll('#pRows button');
    const autoInput = container.querySelector('#pAutoCount');
    const autoStop = container.querySelector('#pAutoStop');

    let risk = 'low';
    let rows = 12;
    let autoRemaining = 0;
    let activeBalls = 0;

    riskBtns.forEach(b => b.addEventListener('click', () => {
      riskBtns.forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      risk = b.dataset.risk;
      renderMults();
    }));
    rowsBtns.forEach(b => b.addEventListener('click', () => {
      rowsBtns.forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      rows = +b.dataset.rows;
      resize();
      renderMults();
    }));
    container.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        let v = +betInput.value || 0;
        if (act === 'half') v = v / 2;
        else if (act === 'dbl') v = v * 2;
        else if (act === 'max') v = Bankroll.get();
        betInput.value = Math.max(0.01, +v.toFixed(2));
      });
    });

    function renderMults() {
      const slots = SLOTS[rows][risk];
      multsEl.innerHTML = '';
      slots.forEach((m, i) => {
        const el = document.createElement('div');
        el.className = 'plinko-mult';
        const [c1, c2] = colorForMult(m);
        el.style.background = `linear-gradient(180deg, ${c1}33, ${c1}11)`;
        el.style.borderColor = c1 + '66';
        el.style.color = c2;
        el.textContent = (m >= 100 ? m.toFixed(0) : m.toFixed(1)) + '×';
        el.dataset.idx = i;
        multsEl.appendChild(el);
      });
    }
    renderMults();

    let layout = {};
    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const r = canvas.parentElement.getBoundingClientRect();
      const cssW = Math.max(280, Math.min(720, r.width - 32));
      const cssH = Math.max(320, r.height - 60);
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
      canvas.width = cssW * dpr;
      canvas.height = cssH * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      computeLayout(cssW, cssH);
      drawBoard();
    }
    function computeLayout(w, h) {
      const padX = 30, padTop = 30, padBottom = 30;
      const usableW = w - padX * 2;
      const usableH = h - padTop - padBottom;
      const bottomPegs = rows + 2;
      const gapX = usableW / (bottomPegs - 1);
      const gapY = Math.min(gapX * 0.92, usableH / rows);
      const totalH = gapY * rows;
      const top = padTop + (usableH - totalH) / 2;
      layout = { w, h, gapX, gapY, padTop: top };
    }
    function pegPos(row, idx) {
      const pegsInRow = row + 3;
      const rowW = (pegsInRow - 1) * layout.gapX;
      const startX = (layout.w - rowW) / 2;
      return { x: startX + idx * layout.gapX, y: layout.padTop + row * layout.gapY };
    }
    function slotCenter(slotIdx) {
      const pegsInRow = rows + 2;
      const rowW = (pegsInRow - 1) * layout.gapX;
      const startX = (layout.w - rowW) / 2;
      return startX + (slotIdx + 0.5) * layout.gapX;
    }
    function drawBoard() {
      ctx.clearRect(0, 0, layout.w, layout.h);
      for (let r = 0; r < rows; r++) {
        const pegs = r + 3;
        for (let i = 0; i < pegs; i++) {
          const p = pegPos(r, i);
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.4)';
          ctx.fill();
        }
      }
    }
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement);
    resize();

    async function drop() {
      const bet = +betInput.value;
      if (!bet || bet <= 0) { Toast.warn('Enter a bet amount'); return; }
      if (!Bankroll.canAfford(bet)) { Toast.error('Insufficient balance'); autoRemaining = 0; return; }

      const preBalance = Bankroll.get();
      let res;
      try {
        res = await API.plinko({ bet, rows, risk });
      } catch (e) { Toast.error(e.message); autoRemaining = 0; return; }
      Bankroll.set(preBalance - bet); // deduct now; credit payout when the ball lands
      Fair.bumpNonce();

      const dirs = res.directions;
      const slotIdx = res.slot;
      const mult = res.mult;
      const win = mult >= 1;

      // Build the path from the server's directions.
      const start = pegPos(0, 1);
      const path = [{ x: start.x, y: start.y - 30 }];
      let col = 1;
      for (let r = 0; r < rows; r++) {
        const peg = pegPos(r, col);
        path.push({ x: peg.x, y: peg.y - 5, kind: 'peg' });
        if (dirs[r] === 1) col += 1;
      }
      const finalY = layout.padTop + rows * layout.gapY + 6;
      path.push({ x: slotCenter(slotIdx), y: finalY, kind: 'slot' });

      activeBalls++;
      animatePath(path, () => {
        activeBalls--;
        Bankroll.set(res.balance); // credit the payout as the ball lands
        const slotEls = multsEl.querySelectorAll('.plinko-mult');
        slotEls.forEach(el => el.classList.remove('flash'));
        const flashEl = slotEls[slotIdx];
        if (flashEl) { flashEl.classList.add('flash'); setTimeout(() => flashEl.classList.remove('flash'), 500); }
        if (mult >= 5) Toast.win(`${mult}× — +${Bankroll.fmt(res.payout - bet)}`);
        else if (win) Toast.info(`${mult}× — +${Bankroll.fmt(res.payout - bet)}`);
        else Toast.loss(`${mult}× — −${Bankroll.fmt(bet - res.payout)}`);
        Feed.recordPlayerBet({ game: 'plinko', bet, mult, win, payout: res.payout });

        if (autoRemaining > 0) {
          autoRemaining -= 1;
          autoInput.value = autoRemaining;
          if (autoRemaining > 0) setTimeout(drop, 320);
        }
      });
    }

    function animatePath(path, done) {
      const segDur = 170;
      let segIdx = 0;
      let segStart = performance.now();
      function frame() {
        const now = performance.now();
        const t = Math.min(1, (now - segStart) / segDur);
        const a = path[segIdx], b = path[segIdx + 1];
        if (!b) { done(); return; }
        const x = a.x + (b.x - a.x) * t;
        const arc = (b.kind === 'peg' || b.kind === 'slot') ? Math.sin(Math.PI * t) * 6 : 0;
        const y = a.y + (b.y - a.y) * t - arc;
        drawBoard();
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        const g = ctx.createRadialGradient(x, y, 0, x, y, 14);
        g.addColorStop(0, 'rgba(255,255,255,0.95)');
        g.addColorStop(1, 'rgba(0,230,118,0)');
        ctx.fillStyle = g; ctx.fill();
        ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
        if (t >= 1) { segIdx++; segStart = now; if (segIdx >= path.length - 1) { done(); return; } }
        if (alive) requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    }

    actionBtn.addEventListener('click', () => {
      const auto = +autoInput.value || 0;
      if (auto > 0) autoRemaining = auto;
      drop();
    });
    autoStop.addEventListener('click', () => { autoRemaining = 0; autoInput.value = 0; });

    let alive = true;
    return function unmount() { alive = false; ro.disconnect(); };
  }

  global.Games = global.Games || {};
  global.Games.plinko = mountPlinko;
})(window);
