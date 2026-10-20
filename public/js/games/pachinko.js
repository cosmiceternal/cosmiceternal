/* Pachinko — drop a ball through 6 rows of pegs. Lands in one of 7 slots,
 * each with a multiplier. Outer slots are rare jackpots (4×); the center is
 * the most likely landing. Server decides; client animates. */
(function (global) {
  'use strict';
  const ROWS = 6;
  const SLOTS = [4, 0.4, 0.8, 1.2, 0.8, 0.4, 4];

  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('pkBet')}
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="pkAction">Drop</button>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Last</span><span class="stat-value" id="pkLast">—</span></div>
        <div class="stat"><span class="stat-label">Top Prize</span><span class="stat-value">4.0×</span></div>
      </div>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">Outer slots pay 4× but are rare. The center is most likely.</p>
    `, `<div class="pachinko-board">
          <div class="pachinko-pegs" id="pkPegs"></div>
          <div class="pachinko-slots" id="pkSlotRow">
            ${SLOTS.map((m, i) => `<div class="pachinko-slot" data-slot="${i}"><span>${m}×</span></div>`).join('')}
          </div>
          <div class="pachinko-ball hidden" id="pkBall"></div>
        </div>
        <div class="crash-status" id="pkStatus">Drop a ball.</div>`, 'pachinko-stage');

    // Render the peg grid: row k has (k+2) pegs, drawn as small bumpers.
    const pegsHost = container.querySelector('#pkPegs');
    for (let r = 0; r < ROWS; r++) {
      const row = document.createElement('div');
      row.className = 'pachinko-row';
      for (let p = 0; p <= r + 1; p++) {
        const peg = document.createElement('span');
        peg.className = 'pachinko-peg';
        row.appendChild(peg);
      }
      pegsHost.appendChild(row);
    }

    const betInput = container.querySelector('#pkBet');
    const action = container.querySelector('#pkAction');
    const ball = container.querySelector('#pkBall');
    const slotRow = container.querySelector('#pkSlotRow');
    const statusEl = container.querySelector('#pkStatus');
    const lastEl = container.querySelector('#pkLast');
    let busy = false, alive = true, animFrame = null;
    GameKit.wireBet(container, betInput);

    // The ball used to hop between pegs in 110ms steps, so it read as a
    // sequence of positions rather than something falling. It now falls on a
    // single rAF timeline: gravity down the board, an eased sidestep off each
    // peg, and a last drop right into the slot it lands in.
    function animateDrop(path, slot, onDone) {
      const startX = 50;        // centre, in %
      const dx = 6;             // % of board width per peg deflection
      const topY = 4, pegGap = 13;
      const slotEl = slotRow.querySelector(`[data-slot="${slot}"]`);

      // Horizontal waypoint after each peg, plus a final nudge onto the slot.
      const xs = [startX];
      for (let i = 0; i < ROWS; i++) xs.push(xs[i] + dx * (path[i] === 1 ? 1 : -1));
      const slotX = slotEl
        ? ((slotEl.offsetLeft + slotEl.offsetWidth / 2) / slotRow.offsetWidth) * 100
        : xs[ROWS];
      xs.push(slotX);

      const PEG_MS = 110;                       // pace of the original drop
      const DROP_MS = 260;                      // the fall into the slot
      const total = ROWS * PEG_MS + DROP_MS;
      const bottomY = topY + ROWS * pegGap;

      ball.classList.remove('hidden');
      // Place the ball before it is shown, so a new drop never starts by
      // sliding across from where the last one finished.
      place(startX, topY);

      function place(x, y) {
        ball.style.left = x + '%';
        ball.style.top = y + '%';
      }

      const start = performance.now();
      function frame(now) {
        if (!alive) return;
        const t = Math.min(1, (now - start) / total);
        const elapsed = t * total;
        let x, y;
        if (elapsed < ROWS * PEG_MS) {
          const seg = elapsed / PEG_MS;         // which peg gap we are in
          const i = Math.min(ROWS - 1, Math.floor(seg));
          const f = seg - i;
          // Sideways eases between pegs; downward accelerates like a fall.
          const ease = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
          x = xs[i] + (xs[i + 1] - xs[i]) * ease;
          y = topY + (i + f * f * 0.5 + (1 - Math.pow(1 - f, 2)) * 0.5) * pegGap;
        } else {
          const f = (elapsed - ROWS * PEG_MS) / DROP_MS;
          x = xs[ROWS] + (xs[ROWS + 1] - xs[ROWS]) * (1 - Math.pow(1 - f, 2));
          y = bottomY + f * f * 9;
        }
        place(x, y);
        if (t < 1) { animFrame = requestAnimationFrame(frame); return; }
        if (slotEl) slotEl.classList.add('hit');
        onDone();
      }

      if (GameKit.reduceMotion()) {
        place(xs[ROWS + 1], bottomY + 9);
        if (slotEl) slotEl.classList.add('hit');
        animFrame = setTimeout(onDone, 120);
        return;
      }
      animFrame = requestAnimationFrame(frame);
    }

    async function play() {
      if (busy) return;
      const b = GameKit.bet(betInput);
      if (b == null) return;
      busy = true; action.disabled = true;
      slotRow.querySelectorAll('.pachinko-slot').forEach(s => s.classList.remove('hit'));
      statusEl.textContent = 'Dropping…';
      try {
        const res = await API.pachinko({ bet: b });
        animateDrop(res.path, res.slot, () => {
          if (!alive) return;
          lastEl.textContent = res.mult > 0 ? res.mult.toFixed(2) + '×' : '—';
          statusEl.textContent = res.mult >= 4 ? `Jackpot! ${res.mult}×`
            : res.mult >= 1 ? `Win — ${res.mult.toFixed(2)}×`
            : 'Bounced into a low slot.';
          GameKit.settle('pachinko', b, res);
          busy = false; action.disabled = false;
        });
      } catch (e) { Toast.error(e.message); busy = false; action.disabled = false; }
    }

    action.addEventListener('click', play);
    return function () { alive = false; if (animFrame) { cancelAnimationFrame(animFrame); clearTimeout(animFrame); } };
  }

  global.Games = global.Games || {};
  global.Games.pachinko = mount;
})(window);
