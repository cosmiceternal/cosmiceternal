/* War — fastest card game in the casino. You vs dealer, one card each.
 * Higher rank wins 2x; tie returns half the bet; lose 0. RTP ≈ 96.2%. */
(function (global) {
  'use strict';
  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('wrBet')}
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="wrAction">Draw</button>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Last</span><span class="stat-value" id="wrLast">—</span></div>
        <div class="stat"><span class="stat-label">Streak</span><span class="stat-value" id="wrStreak">0</span></div>
      </div>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">Higher card wins 2×. Tie returns half your bet. Ace is high.</p>
    `, `<div class="war-table">
          <div class="war-side">
            <div class="war-label">Dealer</div>
            <div class="war-card" id="wrDealer">?</div>
          </div>
          <div class="war-vs">VS</div>
          <div class="war-side">
            <div class="war-label">You</div>
            <div class="war-card" id="wrPlayer">?</div>
          </div>
        </div>
        <div class="crash-status" id="wrStatus">Place a bet and draw.</div>`, 'war-stage');

    const betInput = container.querySelector('#wrBet');
    const action = container.querySelector('#wrAction');
    const playerEl = container.querySelector('#wrPlayer');
    const dealerEl = container.querySelector('#wrDealer');
    const statusEl = container.querySelector('#wrStatus');
    const lastEl = container.querySelector('#wrLast');
    const streakEl = container.querySelector('#wrStreak');
    let busy = false, alive = true, streak = 0;
    GameKit.wireBet(container, betInput);

    async function play() {
      if (busy) return;
      const b = GameKit.bet(betInput);
      if (b == null) return;
      busy = true; action.disabled = true;
      [playerEl, dealerEl].forEach(el => { el.classList.remove('win', 'loss', 'push'); el.textContent = '?'; });
      statusEl.textContent = 'Drawing…';
      try {
        const res = await API.war({ bet: b });
        // Brief animation: flip dealer first, then player.
        setTimeout(() => { if (!alive) return; dealerEl.innerHTML = GameKit.cardHTML(res.dealer); }, 200);
        setTimeout(() => {
          if (!alive) return;
          playerEl.innerHTML = GameKit.cardHTML(res.player);
          const cls = res.outcome === 'win' ? 'win' : (res.outcome === 'tie' ? 'push' : 'loss');
          playerEl.classList.add(cls); dealerEl.classList.add(res.outcome === 'win' ? 'loss' : (res.outcome === 'tie' ? 'push' : 'win'));
          streak = res.outcome === 'win' ? streak + 1 : 0;
          streakEl.textContent = streak;
          lastEl.textContent = res.mult > 0 ? res.mult.toFixed(2) + '×' : '—';
          statusEl.textContent = res.outcome === 'win'  ? 'You win!'
                              : res.outcome === 'tie'  ? 'Tie — half returned.'
                                                       : 'Dealer wins.';
          GameKit.settle('war', b, res);
          busy = false; action.disabled = false;
        }, 500);
      } catch (e) { Toast.error(e.message); busy = false; action.disabled = false; }
    }
    action.addEventListener('click', play);
    return function () { alive = false; };
  }
  global.Games = global.Games || {};
  global.Games.war = mount;
})(window);
