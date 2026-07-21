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

    function animateDrop(path, slot, onDone) {
      // Start the ball above the first peg, drift left/right per path bit.
      ball.classList.remove('hidden');
      const startX = 50; // center, in %
      const dx = 6;      // % per step
      let x = startX, y = 4;
      const step = (i) => {
        if (!alive) return;
        ball.style.left = x + '%';
        ball.style.top  = y + '%';
        if (i >= ROWS) {
          // Snap to the final slot's centre.
          const slotEl = slotRow.querySelector(`[data-slot="${slot}"]`);
          if (slotEl) slotEl.classList.add('hit');
          onDone();
          return;
        }
        const dir = path[i] === 1 ? 1 : -1;
        x += dx * dir;
        y += 13;
        animFrame = setTimeout(() => step(i + 1), 110);
      };
      step(0);
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
    return function () { alive = false; if (animFrame) clearTimeout(animFrame); };
  }

  global.Games = global.Games || {};
  global.Games.pachinko = mount;
})(window);
