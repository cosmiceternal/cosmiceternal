/* Dragon's Gold — themed reel. All reel themes share one server engine
 * (playSlotsThemed); this file is presentation only. The top prize is read
 * from /api/slots/themes rather than hardcoded, because a hardcoded number is
 * how Cosmic Reels ended up advertising 190x on a table that paid 115.50x. */
(function (global) {
  'use strict';
  const ICON = { coin: '🪙', lantern: '🏮', fan: '🪭', koi: '🐟', tiger: '🐯', phoenix: '🔥', pearl: '🔮', dragon: '🐉' };
  const ALL = Object.keys(ICON);
  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('dgBet')}
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="dgAction">Awaken</button>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Last Win</span><span class="stat-value" id="dgLast">—</span></div>
        <div class="stat"><span class="stat-label">Top Prize</span><span class="stat-value" id="dgTop">—</span></div>
      </div>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">Eight symbols and a thin pair pay — the most volatile reel on the floor. Long droughts, huge peaks.</p>
    `, `<div class="slots-reels dragon-reels" id="dgReels">
          ${[0,1,2].map(i => `<div class="slot-reel" id="dgR${i}">${ICON[ALL[ALL.length-1]]}</div>`).join('')}
        </div>
        <div class="crash-status" id="dgStatus">Awaken the reels</div>`, 'slots-stage');

    const betInput = container.querySelector('#dgBet');
    const action = container.querySelector('#dgAction');
    const reels = [0, 1, 2].map(i => container.querySelector('#dgR' + i));
    const statusEl = container.querySelector('#dgStatus');
    const lastEl = container.querySelector('#dgLast');
    const topEl = container.querySelector('#dgTop');
    let busy = false, alive = true;
    const spins = [];
    GameKit.wireBet(container, betInput);

    // True top prize, straight from the server's pay table.
    API.slotThemes().then((t) => {
      if (!alive || !t || !t['dragon']) return;
      topEl.textContent = ICON[ALL[ALL.length - 1]] + ' ' + t['dragon'].top.toFixed(2) + '×';
    }).catch(() => { if (alive) topEl.textContent = '—'; });

    function spinReel(el, stopIcon, delay) {
      const iv = setInterval(() => { el.textContent = ICON[ALL[Math.floor(Math.random() * ALL.length)]]; }, 70);
      spins.push(iv);
      setTimeout(() => {
        if (!alive) return;
        clearInterval(iv);
        el.textContent = stopIcon;
        el.classList.add('land');
        setTimeout(() => el.classList.remove('land'), 300);
      }, delay);
    }

    async function play() {
      if (busy) return;
      const b = GameKit.bet(betInput);
      if (b == null) return;
      busy = true; action.disabled = true;
      reels.forEach(r => r.classList.remove('win'));
      statusEl.textContent = 'Spinning…';
      if (global.Sound) Sound.play('spin');
      try {
        const res = await API.dragonGold({ bet: b });
        const icons = res.symbols.map(s => ICON[s] || '❔');
        spinReel(reels[0], icons[0], 500);
        spinReel(reels[1], icons[1], 800);
        spinReel(reels[2], icons[2], 1100);
        setTimeout(() => {
          if (!alive) return;
          if (res.kind === 'triple') reels.forEach(r => r.classList.add('win'));
          lastEl.textContent = res.mult > 0 ? res.mult.toFixed(2) + '×' : '—';
          statusEl.textContent = res.kind === 'triple' ? 'The dragon wakes! ' + res.mult.toFixed(2) + '×'
            : res.kind === 'pair' ? 'Pair — ' + res.mult.toFixed(2) + '× back' : 'No match';
          GameKit.settle('dragon', b, res);
          busy = false; action.disabled = false;
        }, 1250);
      } catch (e) { Toast.error(e.message); busy = false; action.disabled = false; }
    }
    action.addEventListener('click', play);
    return function () { alive = false; spins.forEach(clearInterval); };
  }
  global.Games = global.Games || {};
  global.Games.dragon = mount;
})(window);
