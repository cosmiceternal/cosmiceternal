/* Progressive jackpot ticker. The pot value rides along on every slot spin
 * response; between spins a slow poll keeps it moving for everyone else. */
(function (global) {
  'use strict';

  const POLL_MS = 15_000;
  let el = null, timer = null, shown = 0;

  function setPot(v) {
    if (typeof v !== 'number' || !isFinite(v)) return;
    shown = v;
    if (el) el.textContent = Bankroll.fmt(v);
  }
  function celebrate(amount) {
    if (global.Confetti) Confetti.burst({ count: 160 });
    if (global.Sound) Sound.play('jackpot');
    Toast.win(`💰 JACKPOT! +${Bankroll.fmt(amount)} CRYPT`);
    const ticker = document.getElementById('jackpotTicker');
    if (ticker) {
      ticker.classList.remove('jp-hit');
      void ticker.offsetWidth;
      ticker.classList.add('jp-hit');
    }
  }
  async function refresh() {
    try { const r = await API.jackpot(); setPot(r.pot); } catch (_) {}
  }
  function init() {
    el = document.getElementById('jackpotValue');
    refresh();
    if (timer) clearInterval(timer);
    timer = setInterval(refresh, POLL_MS);
  }

  global.Jackpot = { init, setPot, celebrate };
})(window);
