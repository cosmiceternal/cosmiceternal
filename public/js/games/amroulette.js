/* American Roulette — double-zero wheel (0, 00, 1–36). One bet per spin. The
 * extra green 00 pocket is what makes the house edge ~5.26%. Pocket 37 = "00". */
(function (global) {
  'use strict';
  const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  const label = (p) => (p === 37 ? '00' : String(p));
  const color = (p) => (p === 0 || p === 37 ? 'green' : (RED.has(p) ? 'red' : 'black'));
  // American wheel pocket order (for a plausible spin cycle).
  const ORDER = [0, 28, 9, 26, 30, 11, 7, 20, 32, 17, 5, 22, 34, 15, 3, 24, 36, 13, 1, 37, 27, 10, 25, 29, 12, 8, 19, 31, 18, 6, 21, 33, 16, 4, 23, 35, 14, 2];

  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('arBet')}
      <div class="field">
        <label>Bet</label>
        <div class="pills ar-pills" id="arType">
          <button class="pill active" data-type="red">Red 2×</button>
          <button class="pill" data-type="black">Black 2×</button>
          <button class="pill" data-type="odd">Odd 2×</button>
          <button class="pill" data-type="even">Even 2×</button>
          <button class="pill" data-type="low">1–18 2×</button>
          <button class="pill" data-type="high">19–36 2×</button>
          <button class="pill" data-type="dozen1">1st 12 · 3×</button>
          <button class="pill" data-type="dozen2">2nd 12 · 3×</button>
          <button class="pill" data-type="dozen3">3rd 12 · 3×</button>
          <button class="pill" data-type="col1">Col 1 · 3×</button>
          <button class="pill" data-type="col2">Col 2 · 3×</button>
          <button class="pill" data-type="col3">Col 3 · 3×</button>
          <button class="pill" data-type="straight" data-num="0">0 · 36×</button>
          <button class="pill" data-type="straight" data-num="37">00 · 36×</button>
          <button class="pill" data-type="straight">Number 36×</button>
        </div>
      </div>
      <div class="field hidden" id="arNumWrap">
        <label>Number (0–36)</label>
        <input id="arNum" type="number" min="0" max="36" step="1" value="7" />
      </div>
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="arAction">Spin</button>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">Double-zero wheel — the 0 and 00 pockets give the house its edge. Straight numbers pay 36×.</p>
    `, `<div class="ar-wheel"><div class="ar-pocket" id="arPocket">—</div></div>
        <div class="ar-recent" id="arRecent"></div>
        <div class="crash-status" id="arStatus">Place a bet and spin</div>`, 'amroulette-stage');

    const betInput = container.querySelector('#arBet');
    const action = container.querySelector('#arAction');
    const pocket = container.querySelector('#arPocket');
    const statusEl = container.querySelector('#arStatus');
    const recent = container.querySelector('#arRecent');
    const numWrap = container.querySelector('#arNumWrap');
    const numInput = container.querySelector('#arNum');
    let betType = 'red', straightNum = 7, busy = false, alive = true, spin = null;
    const history = [];
    GameKit.wireBet(container, betInput);

    container.querySelectorAll('#arType [data-type]').forEach(b => b.addEventListener('click', () => {
      if (busy) return;
      container.querySelectorAll('#arType .pill').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      betType = b.dataset.type;
      if (betType === 'straight' && b.dataset.num != null) { straightNum = Number(b.dataset.num); numWrap.classList.add('hidden'); }
      else if (betType === 'straight') { numWrap.classList.remove('hidden'); straightNum = Number(numInput.value); }
      else { numWrap.classList.add('hidden'); }
    }));
    numInput.addEventListener('input', () => { straightNum = Math.max(0, Math.min(36, Number(numInput.value) || 0)); });

    function renderRecent() {
      recent.innerHTML = history.slice(-9).reverse().map(p =>
        `<span class="ar-chip" data-c="${color(p)}">${label(p)}</span>`).join('');
    }

    async function play() {
      if (busy) return;
      const bet = GameKit.bet(betInput);
      if (bet == null) return;
      busy = true; action.disabled = true;
      pocket.className = 'ar-pocket';
      let i = 0;
      spin = setInterval(() => { const p = ORDER[i++ % ORDER.length]; pocket.textContent = label(p); pocket.dataset.c = color(p); }, 65);
      if (global.Sound) Sound.play('spin');
      try {
        const body = { bet, betType };
        if (betType === 'straight') body.number = straightNum;
        const res = await API.amroulette(body);
        setTimeout(() => {
          if (!alive) return;
          clearInterval(spin);
          pocket.textContent = res.label;
          pocket.dataset.c = res.color;
          pocket.classList.add(res.win ? 'win' : 'loss');
          history.push(res.pocket); renderRecent();
          statusEl.textContent = res.win
            ? `${res.label} ${res.color} — won ${Bankroll.fmt(res.payout - bet)} @ ${res.mult}×!`
            : `${res.label} ${res.color} — no win.`;
          GameKit.settle('amroulette', bet, res);
          busy = false; action.disabled = false;
        }, 950);
      } catch (e) { clearInterval(spin); Toast.error(e.message); busy = false; action.disabled = false; }
    }
    action.addEventListener('click', play);
    return function () { alive = false; if (spin) clearInterval(spin); };
  }
  global.Games = global.Games || {};
  global.Games.amroulette = mount;
})(window);
