/* Fan Tan — the old bead game. A pile of beads is counted out four at a time;
 * you bet what the final remainder will be (1–4). Pays 3.85×. The pile size is
 * cosmetic; the remainder is server-authoritative. */
(function (global) {
  'use strict';
  function mount(container) {
    let busy = false, alive = true, timers = [], pick = 1;
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('ftBet')}
      <div class="field">
        <label>Remainder</label>
        <div class="ft-picks" id="ftPicks">
          ${[1, 2, 3, 4].map(n => `<button class="ft-pick${n === 1 ? ' active' : ''}" data-n="${n}">${n}</button>`).join('')}
        </div>
      </div>
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="ftDeal">Count the Beads</button>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">The dealer removes beads four at a time — bet how many remain in the final group. Pays 3.85×.</p>
    `, `<div class="fantan-board">
          <div class="ft-beads" id="ftBeads"></div>
          <div class="ft-remainder" id="ftRemainder"></div>
        </div>
        <div class="crash-status" id="ftStatus">Pick 1–4 and count the beads</div>`, 'fantan-stage');

    const betInput = container.querySelector('#ftBet');
    const dealBtn = container.querySelector('#ftDeal');
    const statusEl = container.querySelector('#ftStatus');
    const beadsEl = container.querySelector('#ftBeads');
    const remEl = container.querySelector('#ftRemainder');
    GameKit.wireBet(container, betInput);

    container.querySelector('#ftPicks').addEventListener('click', (e) => {
      const b = e.target.closest('[data-n]'); if (!b || busy) return;
      pick = Number(b.dataset.n);
      container.querySelectorAll('.ft-pick').forEach(x => x.classList.toggle('active', x === b));
    });

    async function deal() {
      if (busy) return;
      const b = GameKit.bet(betInput);
      if (b == null) return;
      busy = true; dealBtn.disabled = true;
      remEl.textContent = ''; remEl.className = 'ft-remainder';
      statusEl.textContent = 'Counting…';
      try {
        const res = await API.fantan({ bet: b, pick });
        // Lay out the pile.
        beadsEl.innerHTML = Array.from({ length: res.beads }, (_, i) => `<span class="ft-bead" data-idx="${i}"></span>`).join('');
        const beads = Array.from(beadsEl.children);
        const groups = Math.ceil(res.beads / 4);
        let g = 0;
        const step = () => {
          if (!alive) return;
          if (g < groups - 1) {
            // remove a group of 4
            for (let k = 0; k < 4; k++) { const el = beads[g * 4 + k]; if (el) el.classList.add('removed'); }
            if (global.Sound) Sound.play('tick');
            g++;
            timers.push(setTimeout(step, 130));
          } else {
            // final group = remainder
            for (let k = g * 4; k < beads.length; k++) beads[k].classList.add('final');
            remEl.textContent = res.remainder;
            remEl.classList.add(res.win ? 'win' : 'lose');
            statusEl.textContent = res.win
              ? `Remainder ${res.remainder} — you nailed it! +${Bankroll.fmt(res.payout - b)}`
              : `Remainder ${res.remainder} — you picked ${res.pick}.`;
            GameKit.settle('fantan', b, res);
            busy = false; dealBtn.disabled = false;
          }
        };
        timers.push(setTimeout(step, 250));
      } catch (e) { Toast.error(e.message); busy = false; dealBtn.disabled = false; }
    }
    dealBtn.addEventListener('click', deal);
    return function () { alive = false; timers.forEach(clearTimeout); };
  }
  global.Games = global.Games || {};
  global.Games.fantan = mount;
})(window);
