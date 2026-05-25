/* Color — a digit 0–9 is drawn; bet on its colour. */
(function (global) {
  'use strict';
  const COLORS = [
    { key: 'red', label: 'Red', pay: '2.4×' },
    { key: 'green', label: 'Green', pay: '2.4×' },
    { key: 'violet', label: 'Violet', pay: '4.8×' }
  ];
  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('coBet')}
      <div class="field">
        <label>Pick a Colour</label>
        <div class="color-pick" id="coPick">
          ${COLORS.map((c, i) => `<button class="color-btn ${c.key} ${i === 0 ? 'active' : ''}" data-color="${c.key}">${c.label}<span>${c.pay}</span></button>`).join('')}
        </div>
      </div>
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="coAction">Play</button>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">0 &amp; 5 are violet, {1,3,7,9} red, {2,4,6,8} green.</p>
    `, `<div class="color-digit" id="coDigit">?</div>
        <div class="crash-status" id="coStatus">Pick a colour and play</div>`, 'color-stage');

    const betInput = container.querySelector('#coBet');
    const action = container.querySelector('#coAction');
    const digitEl = container.querySelector('#coDigit');
    const statusEl = container.querySelector('#coStatus');
    let choice = 'red', busy = false, alive = true, spin = null;
    GameKit.wireBet(container, betInput);
    container.querySelectorAll('[data-color]').forEach(b => b.addEventListener('click', () => {
      if (busy) return;
      container.querySelectorAll('[data-color]').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); choice = b.dataset.color;
    }));

    async function play() {
      if (busy) return;
      const b = GameKit.bet(betInput);
      if (b == null) return;
      busy = true; action.disabled = true;
      digitEl.className = 'color-digit';
      let n = 0;
      spin = setInterval(() => { digitEl.textContent = Math.floor(Math.random() * 10); }, 60);
      try {
        const res = await API.color({ bet: b, choice });
        setTimeout(() => {
          if (!alive) return;
          clearInterval(spin);
          digitEl.textContent = res.digit;
          digitEl.classList.add(res.color, res.win ? 'win' : 'loss');
          statusEl.textContent = `${res.digit} is ${res.color} — ${res.win ? 'you won!' : 'you lost'}`;
          GameKit.settle('color', b, res);
          busy = false; action.disabled = false;
        }, 700);
      } catch (e) { clearInterval(spin); Toast.error(e.message); busy = false; action.disabled = false; }
    }
    action.addEventListener('click', play);
    return function () { alive = false; if (spin) clearInterval(spin); };
  }
  global.Games = global.Games || {};
  global.Games.color = mount;
})(window);
