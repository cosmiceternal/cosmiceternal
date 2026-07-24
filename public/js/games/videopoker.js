/* Video Poker (Jacks or Better) — deal, hold, draw. */
(function (global) {
  'use strict';
  const PAYS = [['Royal Flush', '250×'], ['Straight Flush', '50×'], ['Four of a Kind', '25×'], ['Full House', '9×'], ['Flush', '6×'], ['Straight', '4×'], ['Three of a Kind', '3×'], ['Two Pair', '2×'], ['Jacks or Better', '1×']];
  const NAME = { royal: 'Royal Flush', sf: 'Straight Flush', four: 'Four of a Kind', full: 'Full House', flush: 'Flush', straight: 'Straight', three: 'Three of a Kind', twopair: 'Two Pair', jacks: 'Jacks or Better', none: 'No win' };
  function mount(container) {
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('vpBet')}
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="vpAction">Deal</button>
      <div class="pay-list">${PAYS.map(p => `<div class="pay-row"><span>${p[0]}</span><span>${p[1]}</span></div>`).join('')}</div>
    `, `<div class="cards-row" id="vpHand">${[0,1,2,3,4].map(() => GameKit.cardHTML(null, true)).join('')}</div>
        <div class="crash-status" id="vpStatus">Deal to begin — then tap cards to hold</div>`, 'cards-stage');

    const betInput = container.querySelector('#vpBet');
    const action = container.querySelector('#vpAction');
    const handEl = container.querySelector('#vpHand');
    const statusEl = container.querySelector('#vpStatus');
    let roundId = null, bet = 0, busy = false, phase = 'deal';
    const holds = [false, false, false, false, false];
    GameKit.wireBet(container, betInput);

    function renderHand(cards, allowHold) {
      handEl.innerHTML = cards.map((c, i) => {
        const held = holds[i] && allowHold;
        return `<div class="vp-slot ${held ? 'held' : ''}" data-i="${i}">${GameKit.cardHTML(c)}${allowHold ? `<span class="hold-tag">${held ? 'HELD' : 'HOLD'}</span>` : ''}</div>`;
      }).join('');
      if (allowHold) handEl.querySelectorAll('.vp-slot').forEach(s => s.addEventListener('click', () => {
        const i = +s.dataset.i; holds[i] = !holds[i];
        s.classList.toggle('held', holds[i]); s.querySelector('.hold-tag').textContent = holds[i] ? 'HELD' : 'HOLD';
      }));
    }

    async function deal() {
      if (busy) return;
      bet = GameKit.bet(betInput);
      if (bet == null) return;
      busy = true; action.disabled = true;
      holds.fill(false);
      try {
        const res = await API.vpStart({ bet });
        Bankroll.set(res.balance); Fair.bumpNonce();
        roundId = res.roundId; renderHand(res.hand, true);
        phase = 'draw'; action.textContent = 'Draw'; statusEl.textContent = 'Tap cards to hold, then Draw';
      } catch (e) { Toast.error(e.message); }
      finally { busy = false; action.disabled = false; }
    }
    async function draw() {
      if (busy || !roundId) return;
      busy = true; action.disabled = true;
      try {
        const res = await API.vpDraw({ roundId, holds: holds.slice() });
        renderHand(res.hand, false);
        const win = res.mult >= 1;
        Bankroll.set(res.balance);
        Feed.recordPlayerBet({ game: 'videopoker', bet, mult: win ? res.mult : 0, win, payout: res.payout });
        if (win) Toast.win(`${NAME[res.category]} — +${Bankroll.fmt(res.payout - bet)}`);
        else Toast.loss(`−${Bankroll.fmt(bet)}`);
        statusEl.textContent = `${NAME[res.category]}${win ? ' — ' + res.mult + '×' : ''}`;
        roundId = null; phase = 'deal'; action.textContent = 'Deal';
      } catch (e) { Toast.error(e.message); }
      finally { busy = false; action.disabled = false; }
    }
    action.addEventListener('click', () => (phase === 'deal' ? deal() : draw()));
    return function () {};
  }
  global.Games = global.Games || {};
  global.Games.videopoker = mount;
})(window);
