/* Slots — 3 reels, match for a payout. Server decides; client spins. */
(function (global) {
  'use strict';
  const ICON = { cherry: '🍒', lemon: '🍋', bell: '🔔', star: '⭐', bar: '🍫', seven: '7️⃣' };
  const ALL = Object.keys(ICON);
  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('slBet')}
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="slAction">Spin</button>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Last Win</span><span class="stat-value" id="slLast">—</span></div>
        <div class="stat"><span class="stat-label">Top Prize</span><span class="stat-value">7️⃣ 68×</span></div>
      </div>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">Three of a kind pays big; any two matching returns half your bet.</p>
    `, `<div class="slots-reels" id="slReels">
          ${[0,1,2].map(i => `<div class="slot-reel" id="slR${i}">🍒</div>`).join('')}
        </div>
        <div class="crash-status" id="slStatus">Pull the lever</div>`, 'slots-stage');

    const betInput = container.querySelector('#slBet');
    const action = container.querySelector('#slAction');
    const reels = [0, 1, 2].map(i => container.querySelector('#slR' + i));
    const statusEl = container.querySelector('#slStatus');
    const lastEl = container.querySelector('#slLast');
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
        const res = await API.slots({ bet: b });
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
          GameKit.settle('slots', b, res);
          busy = false; action.disabled = false;
        }, 1250);
      } catch (e) { Toast.error(e.message); busy = false; action.disabled = false; }
    }
    action.addEventListener('click', play);
    return function () { alive = false; spins.forEach(clearInterval); };
  }
  global.Games = global.Games || {};
  global.Games.slots = mount;
})(window);
