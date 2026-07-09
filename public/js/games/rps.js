/* RPS Duel — rock, paper, scissors vs the house with a 3-2-1 countdown
 * shake before the reveal. Win pays 1.92×, tie returns your stake. */
(function (global) {
  'use strict';
  const NAMES = ['Rock', 'Paper', 'Scissors'];
  const EMOJI = ['✊', '✋', '✌️'];
  function mount(container) {
    let pick = 0, busy = false, alive = true, timers = [];
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('rpsBet')}
      <div class="field">
        <label>Your Throw</label>
        <div class="rps-pick" id="rpsPick">
          ${EMOJI.map((e, i) => `<button class="rps-btn${i === 0 ? ' active' : ''}" data-p="${i}"><span>${e}</span><small>${NAMES[i]}</small></button>`).join('')}
        </div>
      </div>
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="rpsGo">Throw!</button>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">Beat the house: win pays 1.92×, a tie returns your bet.</p>
    `, `<div class="rps-arena">
          <div class="rps-hand rps-you"><span id="rpsYouHand">✊</span><small>You</small></div>
          <div class="rps-vs" id="rpsVs">VS</div>
          <div class="rps-hand rps-house"><span id="rpsHouseHand">✊</span><small>House</small></div>
        </div>
        <div class="crash-status" id="rpsStatus">Choose your throw.</div>`, 'rps-stage');

    const betInput = container.querySelector('#rpsBet');
    const go = container.querySelector('#rpsGo');
    const youHand = container.querySelector('#rpsYouHand');
    const houseHand = container.querySelector('#rpsHouseHand');
    const arena = container.querySelector('.rps-arena');
    const vs = container.querySelector('#rpsVs');
    const statusEl = container.querySelector('#rpsStatus');
    GameKit.wireBet(container, betInput);

    container.querySelector('#rpsPick').addEventListener('click', (e) => {
      const b = e.target.closest('[data-p]');
      if (!b || busy) return;
      pick = Number(b.dataset.p);
      container.querySelectorAll('.rps-btn').forEach(x => x.classList.toggle('active', x === b));
      youHand.textContent = EMOJI[pick];
    });

    go.addEventListener('click', async () => {
      if (busy) return;
      const b = GameKit.bet(betInput);
      if (b == null) return;
      busy = true; go.disabled = true;
      youHand.textContent = EMOJI[pick];
      arena.classList.add('shaking');
      let count = 3;
      vs.textContent = count;
      statusEl.textContent = 'Rock…';
      const words = ['Rock…', 'Paper…', 'Scissors…', 'Shoot!'];
      try {
        const res = await API.rps({ bet: b, pick });
        const iv = setInterval(() => {
          if (!alive) return;
          count--;
          vs.textContent = count > 0 ? count : 'VS';
          statusEl.textContent = words[3 - count] || 'Shoot!';
          // flicker the house hand during the shake
          houseHand.textContent = EMOJI[Math.floor(Math.random() * 3)];
          if (count <= 0) {
            clearInterval(iv);
            arena.classList.remove('shaking');
            youHand.textContent = res.pickEmoji;
            houseHand.textContent = res.houseEmoji;
            const NAMES2 = { win: 'You win!', lose: 'House wins.', tie: 'Tie — bet returned.' };
            statusEl.textContent = NAMES2[res.outcome];
            arena.classList.add(res.outcome === 'win' ? 'you-win' : (res.outcome === 'tie' ? 'is-tie' : 'house-win'));
            GameKit.settle('rps', b, res);
            timers.push(setTimeout(() => {
              if (!alive) return;
              arena.classList.remove('you-win', 'house-win', 'is-tie');
              busy = false; go.disabled = false;
            }, 1500));
          }
        }, 500);
      } catch (e) { Toast.error(e.message); busy = false; go.disabled = false; arena.classList.remove('shaking'); }
    });

    return function () { alive = false; timers.forEach(clearTimeout); };
  }
  global.Games = global.Games || {};
  global.Games.rps = mount;
})(window);
