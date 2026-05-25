/* Sic Bo — three dice; bet Small/Big/Triple or an exact total. */
(function (global) {
  'use strict';
  const PIP = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('sbBet')}
      <div class="field">
        <label>Bet</label>
        <div class="pills" id="sbType">
          <button class="pill active" data-type="small">Small 4–10 · 2×</button>
          <button class="pill" data-type="big">Big 11–17 · 2×</button>
          <button class="pill" data-type="triple">Any Triple · 31×</button>
          <button class="pill" data-type="total">Exact Total</button>
        </div>
      </div>
      <div class="field hidden" id="sbTotalWrap">
        <label>Total <span id="sbTotalPay" class="muted"></span></label>
        <input id="sbTotal" type="number" min="4" max="17" step="1" value="10" />
      </div>
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="sbAction">Roll</button>
    `, `<div class="dice-row" id="sbDice">${[0,1,2].map(() => `<div class="big-die">⚀</div>`).join('')}</div>
        <div class="crash-status" id="sbStatus">Place a bet and roll</div>`, 'sicbo-stage');

    const betInput = container.querySelector('#sbBet');
    const action = container.querySelector('#sbAction');
    const dice = Array.from(container.querySelectorAll('#sbDice .big-die'));
    const statusEl = container.querySelector('#sbStatus');
    const totalWrap = container.querySelector('#sbTotalWrap');
    const totalInput = container.querySelector('#sbTotal');
    const COUNT = { 4:3,5:6,6:10,7:15,8:21,9:25,10:27,11:27,12:25,13:21,14:15,15:10,16:6,17:3 };
    let betType = 'small', busy = false, alive = true, timers = [];
    GameKit.wireBet(container, betInput);

    function totalPay() {
      const t = +totalInput.value;
      const c = COUNT[t];
      container.querySelector('#sbTotalPay').textContent = c ? (0.97 * 216 / c).toFixed(2) + '×' : '';
    }
    totalInput.addEventListener('input', totalPay);
    container.querySelectorAll('[data-type]').forEach(b => b.addEventListener('click', () => {
      if (busy) return;
      container.querySelectorAll('[data-type]').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); betType = b.dataset.type;
      totalWrap.classList.toggle('hidden', betType !== 'total'); totalPay();
    }));

    async function play() {
      if (busy) return;
      const bet = GameKit.bet(betInput);
      if (bet == null) return;
      busy = true; action.disabled = true;
      const iv = dice.map(d => setInterval(() => { d.textContent = PIP[1 + Math.floor(Math.random() * 6)]; }, 70));
      timers = iv;
      try {
        const body = { bet, betType };
        if (betType === 'total') body.total = +totalInput.value;
        const res = await API.sicbo(body);
        setTimeout(() => {
          if (!alive) return;
          iv.forEach(clearInterval);
          res.dice.forEach((d, i) => dice[i].textContent = PIP[d]);
          statusEl.textContent = `Rolled ${res.dice.join(' · ')} = ${res.sum}${res.triple ? ' (triple!)' : ''} — ${res.win ? 'win ' + res.mult + '×' : 'no win'}`;
          GameKit.settle('sicbo', bet, res);
          busy = false; action.disabled = false;
        }, 700);
      } catch (e) { iv.forEach(clearInterval); Toast.error(e.message); busy = false; action.disabled = false; }
    }
    action.addEventListener('click', play);
    return function () { alive = false; timers.forEach(clearInterval); };
  }
  global.Games = global.Games || {};
  global.Games.sicbo = mount;
})(window);
