/* Lucky Sevens — classic Vegas slot machine. 5 symbols, higher pair rate
 * (~48%), 7-7-7 is the jackpot. Same server-authoritative engine as Slots;
 * theme key is 'sevens' on the server side. */
(function (global) {
  'use strict';
  const ICON = { cherry: '🍒', lemon: '🍋', bell: '🔔', bar: '🍫', seven: '7️⃣' };
  const ALL = Object.keys(ICON);
  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('lsBet')}
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="lsAction">Spin</button>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Last Win</span><span class="stat-value" id="lsLast">—</span></div>
        <div class="stat"><span class="stat-label">Top Prize</span><span class="stat-value">7️⃣ 90×</span></div>
      </div>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">Five symbols means pairs land often. Triple sevens is the jackpot.</p>
    `, `<div class="slots-reels lucky-sevens" id="lsReels">
          ${[0,1,2].map(i => `<div class="slot-reel" id="lsR${i}">7️⃣</div>`).join('')}
        </div>
        <div class="crash-status" id="lsStatus">Pull the lever</div>`, 'slots-stage');

    const betInput = container.querySelector('#lsBet');
    const action = container.querySelector('#lsAction');
    const reels = [0, 1, 2].map(i => container.querySelector('#lsR' + i));
    const statusEl = container.querySelector('#lsStatus');
    const lastEl = container.querySelector('#lsLast');
    let busy = false, alive = true, spins = [];
    GameKit.wireBet(container, betInput);

    function spinReel(el, stopIcon, delay) {
      const iv = setInterval(() => { el.textContent = ICON[ALL[Math.floor(Math.random() * ALL.length)]]; }, 70);
      spins.push(iv);
      setTimeout(() => { if (!alive) return; clearInterval(iv); el.textContent = stopIcon; el.classList.add('land'); setTimeout(() => el.classList.remove('land'), 300); }, delay);
    }

    async function play() {
      if (busy) return;
      const b = GameKit.bet(betInput);
      if (b == null) return;
      busy = true; action.disabled = true;
      reels.forEach(r => r.classList.remove('win'));
      statusEl.textContent = 'Spinning…';
      try {
        const res = await API.luckySevens({ bet: b });
        const icons = res.symbols.map(s => ICON[s]);
        spinReel(reels[0], icons[0], 500);
        spinReel(reels[1], icons[1], 800);
        spinReel(reels[2], icons[2], 1100);
        setTimeout(() => {
          if (!alive) return;
          if (res.kind === 'triple') reels.forEach(r => r.classList.add('win'));
          lastEl.textContent = res.mult > 0 ? res.mult.toFixed(2) + '×' : '—';
          statusEl.textContent = res.kind === 'triple' ? `Jackpot! ${res.mult.toFixed(2)}×`
            : res.kind === 'pair' ? `Pair — ${res.mult.toFixed(2)}× back` : 'No match';
          GameKit.settle('sevens', b, res);
          busy = false; action.disabled = false;
        }, 1250);
      } catch (e) { Toast.error(e.message); busy = false; action.disabled = false; }
    }
    action.addEventListener('click', play);
    return function () { alive = false; spins.forEach(clearInterval); };
  }
  global.Games = global.Games || {};
  global.Games.luckysevens = mount;
})(window);
