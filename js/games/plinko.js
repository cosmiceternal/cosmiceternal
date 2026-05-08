/* Plinko — ball drops through a peg pyramid, bouncing left/right at each row,
 * lands in one of (rows + 1) multiplier slots.
 *
 * The bounce sequence is provably-fair: rows of 0/1 bits drawn from the HMAC.
 * The animated ball follows that exact sequence, so what you see is the
 * outcome — not theatre layered on top.
 */
(function (global) {
  'use strict';

  // Slot multipliers tuned per (rows, risk). House edge ~1%.
  // Values inspired by Stake's plinko, scaled to keep RTP near 99%.
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
    if (m >= 10) return ['#ff5277', '#ffb3c5'];     // pink/red
    if (m >= 2)  return ['#f5c542', '#ffe9a8'];     // gold
    if (m >= 1)  return ['#00e676', '#aaffcc'];     // green
    return ['#3b4756', '#7a8a9a'];                  // muted
  }

  function mountPlinko(container) {
    container.innerHTML = `
      <div class="game-grid">
        <div class="controls">
          <div class="field">
            <label>Bet Amount <span class="muted">USD</span></label>
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
            The ball's path is decided by HMAC-SHA256 before the drop. Higher risk = wider edge multipliers.
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
      slots.forEach((m, i) => {
        const el = document.createElement('div');
        el.className = 'plinko-mult';
        const [c1, c2] = colorForMult(m);
        el.style.background = `linear-gradient(180deg, ${c1}33, ${c1}11)`;
        el.style.borderColor = c1 + '66';
        el.style.color = c2;
        el.textContent = (m >= 100 ? m.toFixed(0) : m.toFixed(m < 1 ? 1 : 1)) + '×';
        el.dataset.idx = i;
        multsEl.appendChild(el);
      });
    }
    renderMults();

    // ---- Geometry ----
    let layout = { px: 0, py: 0, w: 0, h: 0, gap: 0, rows: 12, top: 0 };

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
      // Triangle of pegs: row r has r+3 pegs (3..rows+2). We want bottom row's
      // gap to align with the slot count below the canvas, which is rows+1.
      const bottomPegs = rows + 2;
      const gapX = usableW / (bottomPegs - 1);
      const gapY = Math.min(gapX * 0.92, usableH / rows);
      const totalH = gapY * rows;
      const top = padTop + (usableH - totalH) / 2;
      layout = { padX, padTop: top, w, h, gapX, gapY, rows, bottomPegs };
    }

    function pegPos(row, idx) {
      // row 0 has 3 pegs, row rows-1 has rows+2 pegs
      const pegsInRow = row + 3;
      const rowW = (pegsInRow - 1) * layout.gapX;
      const startX = (layout.w - rowW) / 2;
      return { x: startX + idx * layout.gapX, y: layout.padTop + row * layout.gapY };
    }

    function slotCenter(slotIdx) {
      // Slots are spaced like the bottom peg row (rows+1 slots between rows+2 pegs)
      const pegsInRow = rows + 2;
      const rowW = (pegsInRow - 1) * layout.gapX;
      const startX = (layout.w - rowW) / 2;
      return startX + (slotIdx + 0.5) * layout.gapX;
    }

    function drawBoard(highlightSlot = -1) {
      ctx.clearRect(0, 0, layout.w, layout.h);
      // Pegs
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
      // Slot markers along the bottom of canvas
      const slots = SLOTS[rows][risk];
      const baseY = layout.padTop + rows * layout.gapY + 8;
      for (let i = 0; i < slots.length; i++) {
        const x = slotCenter(i);
        ctx.beginPath();
        ctx.arc(x, baseY, 4, 0, Math.PI * 2);
        ctx.fillStyle = i === highlightSlot ? '#00e676' : 'rgba(255,255,255,0.2)';
        ctx.fill();
      }
    }

    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement);
    resize();

    let dropping = false;

    function drop() {
      if (dropping) return;
      const amount = +betInput.value;
      if (!amount || amount <= 0) return Toast.warn('Enter a bet amount');
      if (!Bankroll.canAfford(amount)) return Toast.error('Insufficient balance');
      Bankroll.add(-amount);

      const sample = Fair.samplePlinko(rows);
      const dirs = sample.directions; // 0 = left, 1 = right
      const slotIdx = dirs.reduce((a, b) => a + b, 0);
      const slots = SLOTS[rows][risk];
      const mult = slots[slotIdx];
      const win = mult >= 1;
      const payout = amount * mult;

      Fair.recordRoll({
        game: 'plinko', nonce: sample.fair.nonce, hash: sample.fair.hash,
        result: `${mult.toFixed(2)}× (slot ${slotIdx})`, ts: Date.now()
      });

      dropping = true;
      // Build the ball's path. Each row pegs[r][col] is the peg the ball
      // strikes; left bounce keeps col, right bounce advances col by 1.
      const start = pegPos(0, 1);
      const path = [{ x: start.x, y: start.y - 30 }];
      let col = 1;
      for (let r = 0; r < rows; r++) {
        const peg = pegPos(r, col);
        path.push({ x: peg.x, y: peg.y - 5, kind: 'peg' });
        if (dirs[r] === 1) col += 1;
      }
      // Land at slot center
      const finalY = layout.padTop + rows * layout.gapY + 6;
      const finalX = slotCenter(slotIdx);
      path.push({ x: finalX, y: finalY, kind: 'slot' });

      animatePath(path, () => {
        // flash slot
        const slotEls = multsEl.querySelectorAll('.plinko-mult');
        slotEls.forEach(el => el.classList.remove('flash'));
        const flashEl = slotEls[slotIdx];
        if (flashEl) {
          flashEl.classList.add('flash');
          setTimeout(() => flashEl.classList.remove('flash'), 500);
        }
        if (win) Bankroll.add(payout);
        if (mult >= 5) Toast.win(`${mult}× — +${Bankroll.fmt(payout - amount)}`);
        else if (win) Toast.info(`${mult}× — +${Bankroll.fmt(payout - amount)}`);
        else Toast.loss(`${mult}× — −${Bankroll.fmt(amount - payout)}`);
        Feed.recordPlayerBet({ game: 'plinko', bet: amount, mult, win, payout });
        dropping = false;

        if (autoRemaining > 0) {
          autoRemaining -= 1;
          autoInput.value = autoRemaining;
          if (autoRemaining > 0 && Bankroll.canAfford(amount)) {
            setTimeout(drop, 350);
          }
        }
      });
    }

    function animatePath(path, done) {
      const segDur = 180; // ms per segment
      let segIdx = 0;
      let segStart = performance.now();

      function frame() {
        const now = performance.now();
        const t = Math.min(1, (now - segStart) / segDur);
        const a = path[segIdx];
        const b = path[segIdx + 1];
        if (!b) { done(); return; }
        const x = a.x + (b.x - a.x) * t;
        // Parabolic bounce between pegs for visual flair
        const arc = b.kind === 'peg' || b.kind === 'slot' ? Math.sin(Math.PI * t) * 6 : 0;
        const y = a.y + (b.y - a.y) * t - arc;
        drawBoard();
        // Trail
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        const grad = ctx.createRadialGradient(x, y, 0, x, y, 14);
        grad.addColorStop(0, 'rgba(255,255,255,0.95)');
        grad.addColorStop(1, 'rgba(0,230,118,0)');
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();

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
    return function unmount() {
      alive = false;
      ro.disconnect();
    };
  }

  global.Games = global.Games || {};
  global.Games.plinko = mountPlinko;
})(window);
