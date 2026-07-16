/* Mega Wheel — a 20-segment money wheel. Spin, watch it decelerate onto a
 * multiplier under the top pointer. Server picks the segment. */
(function (global) {
  'use strict';
  const COLORS = { 0: '#3a3a52', 0.5: '#6dd9b8', 1: '#5aa9ff', 2: '#ffb449', 8: '#ff5e9c' };
  function mount(container) {
    let busy = false, alive = true, raf = null, angle = 0;
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('mwBet')}
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="mwSpin">Spin the Wheel</button>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Last</span><span class="stat-value" id="mwLast">—</span></div>
        <div class="stat"><span class="stat-label">Top</span><span class="stat-value">8×</span></div>
      </div>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">You win whatever multiplier the pointer lands on. Twenty segments, up to 8×.</p>
    `, `<div class="mw-wrap">
          <div class="mw-pointer">▼</div>
          <canvas id="mwCanvas" width="320" height="320" class="mw-canvas"></canvas>
        </div>
        <div class="crash-status" id="mwStatus">Spin to play.</div>`, 'megawheel-stage');

    const betInput = container.querySelector('#mwBet');
    const spinBtn = container.querySelector('#mwSpin');
    const statusEl = container.querySelector('#mwStatus');
    const lastEl = container.querySelector('#mwLast');
    const canvas = container.querySelector('#mwCanvas');
    const ctx = canvas.getContext('2d');
    GameKit.wireBet(container, betInput);

    // Visually shuffle the ring so big/mid segments are spread out.
    const RING = [0,2,0,0.5,1,0,2,0,0.5,8,0,1,0,0.5,2,0,0.5,1,0,0]; // 20 slots, one 8×
    const N = RING.length, SEG = (Math.PI * 2) / N;

    function draw(rot) {
      ctx.clearRect(0, 0, 320, 320);
      ctx.save(); ctx.translate(160, 160); ctx.rotate(rot);
      for (let i = 0; i < N; i++) {
        const m = RING[i];
        ctx.beginPath(); ctx.moveTo(0, 0);
        ctx.arc(0, 0, 150, i * SEG, (i + 1) * SEG);
        ctx.closePath();
        ctx.fillStyle = COLORS[m] || '#3a3a52';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 2; ctx.stroke();
        // label
        ctx.save(); ctx.rotate(i * SEG + SEG / 2);
        ctx.textAlign = 'right'; ctx.fillStyle = m >= 2 ? '#0e0d1a' : '#f3f0ff';
        ctx.font = 'bold 15px sans-serif';
        ctx.fillText(m + '×', 138, 5);
        ctx.restore();
      }
      ctx.restore();
      // hub
      ctx.beginPath(); ctx.arc(160, 160, 22, 0, Math.PI * 2); ctx.fillStyle = '#170a26'; ctx.fill();
      ctx.strokeStyle = '#ffb449'; ctx.lineWidth = 3; ctx.stroke();
    }
    draw(angle);

    spinBtn.addEventListener('click', async () => {
      if (busy) return;
      const b = GameKit.bet(betInput);
      if (b == null) return;
      busy = true; spinBtn.disabled = true;
      statusEl.textContent = 'Spinning…';
        if (global.Sound) Sound.play('spin');
      try {
        const res = await API.megawheel({ bet: b });
        // Find a ring index that shows res.mult; land the pointer (top, -PI/2) on it.
        const candidates = RING.map((m, i) => m === res.mult ? i : -1).filter(i => i >= 0);
        const landIdx = candidates[Math.floor(Math.random() * candidates.length)];
        // Pointer sits at top; segment center under it must be landIdx.
        const targetCenter = -Math.PI / 2 - (landIdx * SEG + SEG / 2);
        const spins = 5 + Math.random() * 2;
        const start = angle;
        const end = targetCenter - Math.PI * 2 * spins;
        const t0 = performance.now(), DUR = 4200;
        function frame(now) {
          if (!alive) return;
          const t = Math.min(1, (now - t0) / DUR);
          const ease = 1 - Math.pow(1 - t, 3);
          angle = start + (end - start) * ease;
          draw(angle);
          if (t < 1) raf = requestAnimationFrame(frame);
          else {
            angle = ((end % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
            lastEl.textContent = res.mult + '×';
            statusEl.textContent = res.mult >= 1 ? `Landed on ${res.mult}× — you win!` : 'Landed on 0×. Spin again.';
            GameKit.settle('megawheel', b, res);
            busy = false; spinBtn.disabled = false;
          }
        }
        raf = requestAnimationFrame(frame);
      } catch (e) { Toast.error(e.message); busy = false; spinBtn.disabled = false; }
    });

    return function () { alive = false; if (raf) cancelAnimationFrame(raf); };
  }
  global.Games = global.Games || {};
  global.Games.megawheel = mount;
})(window);
