/* Wheel — spin a 10-segment wheel; risk sets the payout spread. */
(function (global) {
  'use strict';
  // Mirror of the server paytables (server still decides the outcome).
  const WHEEL = {
    low:  [1.2, 1.2, 0, 1.2, 1.5, 1.2, 0, 1.2, 1.2, 1.2],
    mid:  [0, 1.7, 0, 2.0, 0, 1.7, 0, 2.5, 0, 2.0],
    high: [0, 0, 0, 0, 4.0, 0, 0, 0, 0, 5.9]
  };
  const SEG = 92, REPEATS = 14;
  function segClass(m) { return m === 0 ? 'lo' : (m >= 3 ? 'hi' : 'md'); }

  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('whBet')}
      <div class="field">
        <label>Risk</label>
        <div class="pills" id="whRisk">
          ${['low', 'mid', 'high'].map((r, i) => `<button class="pill ${i === 1 ? 'active' : ''}" data-risk="${r}">${r[0].toUpperCase() + r.slice(1)}</button>`).join('')}
        </div>
      </div>
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="whAction">Spin</button>
    `, `<div class="wheel-pointer"></div>
        <div class="wheel-window"><div class="wheel-strip" id="whStrip"></div></div>
        <div class="crash-status" id="whStatus">Choose risk and spin</div>`, 'wheel-stage');

    const betInput = container.querySelector('#whBet');
    const action = container.querySelector('#whAction');
    const strip = container.querySelector('#whStrip');
    const win = container.querySelector('.wheel-window');
    const statusEl = container.querySelector('#whStatus');
    let risk = 'mid', busy = false, alive = true;
    GameKit.wireBet(container, betInput);

    function build() {
      const segs = WHEEL[risk];
      let html = '';
      for (let r = 0; r < REPEATS; r++) {
        segs.forEach(m => { html += `<div class="wheel-seg ${segClass(m)}" style="width:${SEG}px">${m === 0 ? '✕' : m + '×'}</div>`; });
      }
      strip.innerHTML = html;
      strip.style.transition = 'none';
      strip.style.transform = 'translateX(0)';
    }
    build();
    container.querySelectorAll('[data-risk]').forEach(b => b.addEventListener('click', () => {
      if (busy) return;
      container.querySelectorAll('[data-risk]').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); risk = b.dataset.risk; build();
    }));

    async function play() {
      if (busy) return;
      const bet = GameKit.bet(betInput);
      if (bet == null) return;
      busy = true; action.disabled = true;
      statusEl.textContent = 'Spinning…';
      try {
        const res = await API.wheel({ bet, risk });
        const center = win.getBoundingClientRect().width / 2;
        const cell = (REPEATS - 2) * 10 + res.idx;
        const targetX = center - (cell * SEG + SEG / 2);
        strip.style.transition = 'none';
        strip.style.transform = `translateX(${center - ((cell - 24) * SEG + SEG / 2)}px)`;
        void strip.offsetWidth;
        strip.style.transition = 'transform 2.6s cubic-bezier(0.15,0.85,0.2,1)';
        strip.style.transform = `translateX(${targetX}px)`;
        setTimeout(() => {
          if (!alive) return;
          statusEl.textContent = res.mult > 0 ? `Landed ${res.mult}× — won ${Bankroll.fmt(res.payout - bet)}` : 'Landed ✕ — no win';
          GameKit.settle('wheel', bet, res);
          busy = false; action.disabled = false;
        }, 2700);
      } catch (e) { statusEl.textContent = 'Choose risk and spin'; Toast.error(e.message); busy = false; action.disabled = false; }
    }
    action.addEventListener('click', play);
    return function () { alive = false; };
  }
  global.Games = global.Games || {};
  global.Games.wheel = mount;
})(window);
