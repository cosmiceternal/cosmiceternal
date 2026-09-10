/* Crypt Reels — themed reel. All reel themes share one server engine
 * (playSlotsThemed); this file is presentation only. The top prize is read
 * from /api/slots/themes rather than hardcoded, because a hardcoded number is
 * how Cosmic Reels ended up advertising 190x on a table that paid 115.50x. */
(function (global) {
  'use strict';
  const ICON = { bat: '🦇', spider: '🕷️', pumpkin: '🎃', coffin: '⚰️', ghost: '👻', skull: '💀' };
  const ALL = Object.keys(ICON);
  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('cr2Bet')}
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="cr2Action">Spin</button>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Last Win</span><span class="stat-value" id="cr2Last">—</span></div>
        <div class="stat"><span class="stat-label">Top Prize</span><span class="stat-value" id="cr2Top">—</span></div>
      </div>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">Six graveyard symbols, evenly stepped — the house standard. Three skulls is the big one.</p>
    `, `<div class="slots-reels crypt-reels" id="cr2Reels">
          ${[0,1,2].map(i => `<div class="slot-reel" id="cr2R${i}">${ICON[ALL[ALL.length-1]]}</div>`).join('')}
        </div>
        <div class="crash-status" id="cr2Status">Spin the reels</div>`, 'slots-stage');

    const betInput = container.querySelector('#cr2Bet');
    const action = container.querySelector('#cr2Action');
    const reels = [0, 1, 2].map(i => container.querySelector('#cr2R' + i));
    const statusEl = container.querySelector('#cr2Status');
    const lastEl = container.querySelector('#cr2Last');
    const topEl = container.querySelector('#cr2Top');
    let busy = false, alive = true;
    const spins = [];
    GameKit.wireBet(container, betInput);

    // True top prize, straight from the server's pay table.
    API.slotThemes().then((t) => {
      if (!alive || !t || !t['crypt']) return;
      topEl.textContent = ICON[ALL[ALL.length - 1]] + ' ' + t['crypt'].top.toFixed(2) + '×';
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
        const res = await API.cryptReels({ bet: b });
        const icons = res.symbols.map(s => ICON[s] || '❔');
        spinReel(reels[0], icons[0], 500);
        spinReel(reels[1], icons[1], 800);
        spinReel(reels[2], icons[2], 1100);
        setTimeout(() => {
          if (!alive) return;
          if (res.kind === 'triple') reels.forEach(r => r.classList.add('win'));
          lastEl.textContent = res.mult > 0 ? res.mult.toFixed(2) + '×' : '—';
          statusEl.textContent = res.kind === 'triple' ? 'Three skulls! ' + res.mult.toFixed(2) + '×'
            : res.kind === 'pair' ? 'Pair — ' + res.mult.toFixed(2) + '× back' : 'No match';
          GameKit.settle('crypt', b, res);
          busy = false; action.disabled = false;
        }, 1250);
      } catch (e) { Toast.error(e.message); busy = false; action.disabled = false; }
    }
    action.addEventListener('click', play);
    return function () { alive = false; spins.forEach(clearInterval); };
  }
  global.Games = global.Games || {};
  global.Games.crypt = mount;
})(window);
