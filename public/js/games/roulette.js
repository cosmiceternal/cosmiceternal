/* Roulette — European single-zero wheel; spin and settle one bet. */
(function (global) {
  'use strict';
  const RED = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
  const color = n => (n === 0 ? 'green' : (RED.has(n) ? 'red' : 'black'));
  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('roBet')}
      <div class="field">
        <label>Bet</label>
        <div class="pills" id="roType">
          <button class="pill active" data-type="red">Red 2×</button>
          <button class="pill" data-type="black">Black 2×</button>
          <button class="pill" data-type="green">0 · 36×</button>
          <button class="pill" data-type="odd">Odd 2×</button>
          <button class="pill" data-type="even">Even 2×</button>
          <button class="pill" data-type="low">1–18 · 2×</button>
          <button class="pill" data-type="high">19–36 · 2×</button>
          <button class="pill" data-type="dozen1">1st 12 · 3×</button>
          <button class="pill" data-type="dozen2">2nd 12 · 3×</button>
          <button class="pill" data-type="dozen3">3rd 12 · 3×</button>
          <button class="pill" data-type="straight">Number 36×</button>
        </div>
      </div>
      <div class="field hidden" id="roNumWrap">
        <label>Number (0–36)</label>
        <input id="roNum" type="number" min="0" max="36" step="1" value="7" />
      </div>
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="roAction">Spin</button>
    `, `<div class="roulette-pocket" id="roPocket">—</div>
        <div class="crash-status" id="roStatus">Place a bet and spin</div>`, 'roulette-stage');

    const betInput = container.querySelector('#roBet');
    const action = container.querySelector('#roAction');
    const pocket = container.querySelector('#roPocket');
    const statusEl = container.querySelector('#roStatus');
    const numWrap = container.querySelector('#roNumWrap');
    const numInput = container.querySelector('#roNum');
    let betType = 'red', busy = false, alive = true, spin = null;
    GameKit.wireBet(container, betInput);
    container.querySelectorAll('[data-type]').forEach(b => b.addEventListener('click', () => {
      if (busy) return;
      container.querySelectorAll('[data-type]').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); betType = b.dataset.type;
      numWrap.classList.toggle('hidden', betType !== 'straight');
    }));

    async function play() {
      if (busy) return;
      const bet = GameKit.bet(betInput);
      if (bet == null) return;
      busy = true; action.disabled = true;
      pocket.className = 'roulette-pocket';
      spin = setInterval(() => { const n = Math.floor(Math.random() * 37); pocket.textContent = n; pocket.dataset.c = color(n); }, 70);
      try {
        const body = { bet, betType };
        if (betType === 'straight') body.number = +numInput.value;
        const res = await API.roulette(body);
        setTimeout(() => {
          if (!alive) return;
          clearInterval(spin);
          pocket.textContent = res.pocket;
          pocket.dataset.c = res.color;
          pocket.classList.add(res.win ? 'win' : 'loss');
          statusEl.textContent = `${res.pocket} ${res.color} — ${res.win ? 'won ' + Bankroll.fmt(res.payout - bet) : 'no win'}`;
          GameKit.settle('roulette', bet, res);
          busy = false; action.disabled = false;
        }, 900);
      } catch (e) { clearInterval(spin); Toast.error(e.message); busy = false; action.disabled = false; }
    }
    action.addEventListener('click', play);
    return function () { alive = false; if (spin) clearInterval(spin); };
  }
  global.Games = global.Games || {};
  global.Games.roulette = mount;
})(window);
