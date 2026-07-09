/* Derby — back a horse, watch six runners animate down the track. The server
 * picks the winner; the client choreographs a race that ends on it. */
(function (global) {
  'use strict';
  const HORSES = [
    { name: 'Thunderbolt', emoji: '🏇', odds: 2.82 },
    { name: 'Midnight',    emoji: '🐎', odds: 3.84 },
    { name: 'Comet',       emoji: '🏇', odds: 5.33 },
    { name: 'Duchess',     emoji: '🐎', odds: 8.0 },
    { name: 'Rebel',       emoji: '🏇', odds: 12.0 },
    { name: 'Longshot',    emoji: '🐎', odds: 32.0 }
  ];
  function mount(container) {
    let pick = 0, busy = false, alive = true, raf = null;
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('dbBet')}
      <div class="field">
        <label>Your Horse</label>
        <div class="derby-pick" id="dbPick">
          ${HORSES.map((h, i) => `<button class="derby-pick-btn${i === 0 ? ' active' : ''}" data-h="${i}">
            <span class="dp-emoji">${h.emoji}</span>
            <span class="dp-name">${h.name}</span>
            <span class="dp-odds">${h.odds.toFixed(2)}×</span>
          </button>`).join('')}
        </div>
      </div>
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="dbGo">Race!</button>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">Six runners, fixed odds. Back one — if it wins, you're paid its odds.</p>
    `, `<div class="derby-track" id="dbTrack">
          ${HORSES.map((h, i) => `<div class="derby-lane" data-lane="${i}">
            <span class="derby-runner" id="dbRun${i}">${h.emoji}</span>
            <span class="derby-finish">🏁</span>
          </div>`).join('')}
        </div>
        <div class="crash-status" id="dbStatus">Pick a horse and race.</div>`, 'derby-stage');

    const betInput = container.querySelector('#dbBet');
    const go = container.querySelector('#dbGo');
    const statusEl = container.querySelector('#dbStatus');
    const runners = HORSES.map((_, i) => container.querySelector('#dbRun' + i));
    GameKit.wireBet(container, betInput);

    container.querySelector('#dbPick').addEventListener('click', (e) => {
      const b = e.target.closest('[data-h]');
      if (!b || busy) return;
      pick = Number(b.dataset.h);
      container.querySelectorAll('.derby-pick-btn').forEach(x => x.classList.toggle('active', x === b));
    });

    go.addEventListener('click', async () => {
      if (busy) return;
      const b = GameKit.bet(betInput);
      if (b == null) return;
      busy = true; go.disabled = true;
      runners.forEach(r => { r.style.left = '2%'; });
      statusEl.textContent = 'And they\'re off!';
      try {
        const res = await API.derby({ bet: b, pick });
        // Give each horse a random pace, but force the winner to arrive first.
        const paces = HORSES.map(() => 0.55 + Math.random() * 0.4);
        paces[res.winner] = 1.0;
        const start = performance.now();
        const DURATION = 3200;
        function frame(now) {
          if (!alive) return;
          const t = Math.min(1, (now - start) / DURATION);
          const ease = 1 - Math.pow(1 - t, 2);
          runners.forEach((r, i) => {
            const prog = Math.min(0.9, ease * paces[i]);
            r.style.left = (2 + prog * 86) + '%';
            r.classList.toggle('galloping', t < 1);
          });
          if (t < 1) { raf = requestAnimationFrame(frame); }
          else finish(res, b);
        }
        raf = requestAnimationFrame(frame);
      } catch (e) { Toast.error(e.message); busy = false; go.disabled = false; }
    });

    function finish(res, b) {
      const wr = runners[res.winner];
      wr.style.left = '90%';
      wr.classList.add('winner');
      container.querySelector(`[data-lane="${res.winner}"]`).classList.add('won-lane');
      statusEl.textContent = res.won
        ? `${HORSES[res.winner].name} wins — you called it! ${res.mult.toFixed(2)}×`
        : `${HORSES[res.winner].name} takes it. Your ${HORSES[res.pick].name} placed elsewhere.`;
      GameKit.settle('derby', b, res);
      setTimeout(() => {
        if (!alive) return;
        runners.forEach(r => r.classList.remove('winner', 'galloping'));
        container.querySelectorAll('.derby-lane').forEach(l => l.classList.remove('won-lane'));
        busy = false; go.disabled = false;
      }, 1800);
    }

    return function () { alive = false; if (raf) cancelAnimationFrame(raf); };
  }
  global.Games = global.Games || {};
  global.Games.derby = mount;
})(window);
