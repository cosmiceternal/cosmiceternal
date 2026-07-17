/* Mini Roulette — a fast 13-pocket wheel (0 + 1–12). Bet a single number
 * (12.5×) or an even-money option (red/black, odd/even, low/high) that pays 2×
 * with la partage (half back on 0). Canvas wheel spins onto the result. */
(function (global) {
  'use strict';
  const RED = new Set([1, 3, 5, 7, 9, 11]);
  // Wheel order (0 at top, then alternating-ish around).
  const ORDER = [0, 5, 10, 3, 8, 1, 6, 11, 4, 9, 2, 7, 12];
  function colorOf(n) { return n === 0 ? '#3ea66d' : (RED.has(n) ? '#e0484f' : '#20202e'); }
  function mount(container) {
    let busy = false, alive = true, raf = null, angle = 0;
    let betType = 'red', betNumber = 7;
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('mrBet')}
      <div class="field">
        <label>Bet</label>
        <div class="mr-bets" id="mrBets">
          <button class="mr-bet active" data-t="red">Red 2×</button>
          <button class="mr-bet" data-t="black">Black 2×</button>
          <button class="mr-bet" data-t="odd">Odd 2×</button>
          <button class="mr-bet" data-t="even">Even 2×</button>
          <button class="mr-bet" data-t="low">1–6 2×</button>
          <button class="mr-bet" data-t="high">7–12 2×</button>
        </div>
        <div class="mr-numbers" id="mrNums">
          ${Array.from({ length: 13 }, (_, n) => `<button class="mr-num" data-n="${n}" style="--nc:${colorOf(n)}">${n}</button>`).join('')}
        </div>
      </div>
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="mrSpin">Spin</button>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">Even-money bets pay 2× and return half your stake if 0 lands (la partage). Single number pays 12.5×.</p>
    `, `<div class="mr-wrap">
          <div class="mr-pointer">▼</div>
          <canvas id="mrCanvas" width="300" height="300" class="mr-canvas"></canvas>
        </div>
        <div class="crash-status" id="mrStatus">Place a bet and spin.</div>`, 'miniroulette-stage');

    const betInput = container.querySelector('#mrBet');
    const spinBtn = container.querySelector('#mrSpin');
    const statusEl = container.querySelector('#mrStatus');
    const canvas = container.querySelector('#mrCanvas');
    const ctx = canvas.getContext('2d');
    GameKit.wireBet(container, betInput);

    container.querySelector('#mrBets').addEventListener('click', (e) => {
      const b = e.target.closest('[data-t]'); if (!b || busy) return;
      betType = b.dataset.t;
      container.querySelectorAll('.mr-bet').forEach(x => x.classList.toggle('active', x === b));
      container.querySelectorAll('.mr-num').forEach(x => x.classList.remove('active'));
    });
    container.querySelector('#mrNums').addEventListener('click', (e) => {
      const b = e.target.closest('[data-n]'); if (!b || busy) return;
      betType = 'straight'; betNumber = Number(b.dataset.n);
      container.querySelectorAll('.mr-num').forEach(x => x.classList.toggle('active', x === b));
      container.querySelectorAll('.mr-bet').forEach(x => x.classList.remove('active'));
    });

    const N = ORDER.length, SEG = (Math.PI * 2) / N;
    function draw(rot) {
      ctx.clearRect(0, 0, 300, 300);
      ctx.save(); ctx.translate(150, 150); ctx.rotate(rot);
      ORDER.forEach((num, i) => {
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 140, i * SEG, (i + 1) * SEG); ctx.closePath();
        ctx.fillStyle = colorOf(num); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.save(); ctx.rotate(i * SEG + SEG / 2);
        ctx.textAlign = 'right'; ctx.fillStyle = '#fff'; ctx.font = 'bold 15px sans-serif';
        ctx.fillText(num, 128, 5); ctx.restore();
      });
      ctx.restore();
      ctx.beginPath(); ctx.arc(150, 150, 26, 0, Math.PI * 2); ctx.fillStyle = '#170a26'; ctx.fill();
      ctx.strokeStyle = '#ffc061'; ctx.lineWidth = 3; ctx.stroke();
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
        const body = betType === 'straight' ? { bet: b, betType, number: betNumber } : { bet: b, betType };
        const res = await API.miniroulette(body);
        const landIdx = ORDER.indexOf(res.result);
        const target = -Math.PI / 2 - (landIdx * SEG + SEG / 2);
        const start = angle, end = target - Math.PI * 2 * (5 + Math.random() * 2);
        const t0 = performance.now(), DUR = 3800;
        function frame(now) {
          if (!alive) return;
          const t = Math.min(1, (now - t0) / DUR), ease = 1 - Math.pow(1 - t, 3);
          angle = start + (end - start) * ease; draw(angle);
          if (t < 1) raf = requestAnimationFrame(frame);
          else {
            angle = ((end % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
            const NAME = { straight: 'Single', red: 'Red', black: 'Black', odd: 'Odd', even: 'Even', low: '1–6', high: '7–12' };
            statusEl.textContent = res.mult >= 1
              ? `${res.result} ${res.color} — ${NAME[res.betType]} wins ${res.mult}×!`
              : (res.laPartage ? `0 — half your stake back (la partage).` : `${res.result} ${res.color}. No win.`);
            GameKit.settle('miniroulette', b, res);
            busy = false; spinBtn.disabled = false;
          }
        }
        raf = requestAnimationFrame(frame);
      } catch (e) { Toast.error(e.message); busy = false; spinBtn.disabled = false; }
    });

    return function () { alive = false; if (raf) cancelAnimationFrame(raf); };
  }
  global.Games = global.Games || {};
  global.Games.miniroulette = mount;
})(window);
