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
          high: [105, 20, 8, 2.3, 0.8, 0.2, 0.2, 0.2, 0.8, 2.3, 8, 20, 105] },
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
      // Lets the stylesheet tighten type on the denser 13/17-slot boards.
      multsEl.dataset.count = String(slots.length);
      slots.forEach((m, i) => {
        const el = document.createElement('div');
        el.className = 'plinko-mult';
        const [c1, c2] = colorForMult(m);
        el.style.background = `linear-gradient(180deg, ${c1}33, ${c1}11)`;
        el.style.borderColor = c1 + '66';
        el.style.color = c2;
        // The 17-slot board leaves ~24px per chip; "1000×" does not fit, so the
        // densest layout drops the × (the row is unmistakably multipliers).
        const label = m >= 100 ? m.toFixed(0) : m.toFixed(1);
        el.textContent = slots.length >= 17 ? label : label + '×';
        el.dataset.idx = i;
        multsEl.appendChild(el);
      });
    }
    renderMults();

    let layout = {};
    const PAD_X = 30, PAD_TOP = 26, PAD_BOTTOM = 18;
    function resize() {
      const dpr = window.devicePixelRatio || 1;
      const r = canvas.parentElement.getBoundingClientRect();
      const cssW = Math.max(280, Math.min(720, r.width - 32));
      const availH = Math.max(260, r.height - 70);
      // Peg spacing follows the width, then the canvas is sized to the board's
      // NATURAL height. Filling the stage instead left the pegs floating with a
      // long gap between the last row and the payout chips underneath.
      const gapX = (cssW - PAD_X * 2) / (rows + 1);
      const gapY = Math.min(gapX * 0.92, (availH - PAD_TOP - PAD_BOTTOM) / rows);
      const cssH = Math.min(availH, PAD_TOP + gapY * rows + PAD_BOTTOM);
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
      canvas.width = cssW * dpr;
      canvas.height = cssH * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      layout = { w: cssW, h: cssH, gapX, gapY, padTop: PAD_TOP };
      drawBoard();
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
    // `hit` = { row, idx, strength 0..1 } for the peg the ball just struck.
    function drawBoard(hit) {
      ctx.clearRect(0, 0, layout.w, layout.h);
      for (let r = 0; r < rows; r++) {
        const pegs = r + 3;
        for (let i = 0; i < pegs; i++) {
          const p = pegPos(r, i);
          const lit = hit && hit.row === r && hit.idx === i ? hit.strength : 0;
          if (lit > 0) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, 3 + 5 * lit, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255,94,156,${0.35 * lit})`;
            ctx.fill();
          }
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3 + lit, 0, Math.PI * 2);
          ctx.fillStyle = lit > 0
            ? `rgba(255,255,255,${0.4 + 0.6 * lit})`
            : 'rgba(255,255,255,0.4)';
          ctx.fill();
        }
      }
    }
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement);
    resize();

    async function drop() {
      if (!alive) return; // a pending auto-drop must not fire a real bet after unmount
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
        // row/idx let the animation light up the exact peg being struck.
        path.push({ x: peg.x, y: peg.y - 5, kind: 'peg', row: r, idx: col });
        if (dirs[r] === 1) col += 1;
      }
      const finalY = layout.padTop + rows * layout.gapY + 6;
      path.push({ x: slotCenter(slotIdx), y: finalY, kind: 'slot' });

      animatePath(path, () => {
        Bankroll.set(res.balance); // credit the payout as the ball lands
        const slotEls = multsEl.querySelectorAll('.plinko-mult');
        slotEls.forEach(el => el.classList.remove('flash'));
        const flashEl = slotEls[slotIdx];
        if (flashEl) { flashEl.classList.add('flash'); setTimeout(() => flashEl.classList.remove('flash'), 500); }
        if (mult >= 5) Toast.win(`${mult}× — +${Bankroll.fmt(res.payout - bet)}`);
        else if (win) Toast.info(`${mult}× — +${Bankroll.fmt(res.payout - bet)}`);
        else Toast.loss(`${mult}× — −${Bankroll.fmt(bet - res.payout)}`);
        Feed.recordPlayerBet({ game: 'plinko', bet, mult, win, payout: res.payout, profit: res.payout - bet });

        if (autoRemaining > 0) {
          autoRemaining -= 1;
          autoInput.value = autoRemaining;
          if (autoRemaining > 0) setTimeout(drop, 320);
        }
      });
    }

    function animatePath(path, done) {
      // The PATH is whatever the server drew — only the motion is cosmetic.
      // Previously every row took a flat 170ms, so the ball descended at a
      // constant crawl. A falling ball accelerates, so each row is crossed
      // faster than the one above it, every peg contact throws a short hop and
      // squashes the ball, and a fading trail sells the speed.
      const FIRST_ROW_MS = 230;   // slow, readable start
      const ACCEL = 0.19;         // fraction shaved off each successive row
      const segMs = (i) => Math.max(62, FIRST_ROW_MS / (1 + i * ACCEL));

      const trail = [];
      let segIdx = 0;
      let segStart = performance.now();

      function frame() {
        const now = performance.now();
        const a = path[segIdx], b = path[segIdx + 1];
        if (!b) { done(); return; }
        const dur = segMs(segIdx);
        const t = Math.min(1, (now - segStart) / dur);

        const x = a.x + (b.x - a.x) * t;
        // Arc up out of the peg, then fall — a bounce rather than a straight line.
        const hopH = b.kind === 'slot' ? 4 : 10;
        const y = a.y + (b.y - a.y) * t - Math.sin(Math.PI * t) * hopH;

        // Impact squash: briefly flatten on contact, then recover.
        const impact = t < 0.18 && segIdx > 0 ? (1 - t / 0.18) : 0;
        const rx = 6 + 2.5 * impact;
        const ry = 6 - 2.5 * impact;

        // The peg being struck lights up as the ball leaves it.
        const hit = (segIdx > 0 && a.kind === 'peg' && a.row != null)
          ? { row: a.row, idx: a.idx, strength: Math.max(0, 1 - t * 2.2) }
          : null;

        trail.push({ x, y });
        if (trail.length > 9) trail.shift();

        drawBoard(hit);

        // Fading trail behind the ball.
        for (let i = 0; i < trail.length - 1; i++) {
          const pt = trail[i], alpha = (i / trail.length) * 0.30;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 2 + (i / trail.length) * 3.4, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255,94,156,${alpha})`;
          ctx.fill();
        }

        // Glow + ball (squashed on impact).
        const g = ctx.createRadialGradient(x, y, 0, x, y, 16);
        g.addColorStop(0, 'rgba(255,255,255,0.95)');
        g.addColorStop(0.45, 'rgba(255,94,156,0.35)');
        g.addColorStop(1, 'rgba(255,94,156,0)');
        ctx.beginPath(); ctx.arc(x, y, 15, 0, Math.PI * 2);
        ctx.fillStyle = g; ctx.fill();

        ctx.save();
        ctx.translate(x, y);
        ctx.beginPath();
        ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.restore();

        if (t >= 1) {
          segIdx++;
          segStart = now;
          if (segIdx >= path.length - 1) { done(); return; }
        }
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
