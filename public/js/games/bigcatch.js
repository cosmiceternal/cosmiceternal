/* Big Catch — cast a line, wait through the suspenseful reel-in, see what you
 * hooked. A golden whale (40×) is the rare monster catch. */
(function (global) {
  'use strict';
  function mount(container) {
    let busy = false, alive = true, timers = [];
    container.innerHTML = GameKit.frame(`
      ${GameKit.betRow('bcBet')}
      <div class="divider"></div>
      <button class="btn btn-primary btn-block" id="bcCast">Cast Line 🎣</button>
      <div class="stat-grid">
        <div class="stat"><span class="stat-label">Last catch</span><span class="stat-value" id="bcLast">—</span></div>
        <div class="stat"><span class="stat-label">Monster</span><span class="stat-value">🐋 40×</span></div>
      </div>
      <p class="muted" style="font-size:11px;line-height:1.5;margin:0;">Cast and reel in. Every catch is a multiplier — hook the whale for 40×.</p>
    `, `<div class="fishing-scene" id="bcScene">
          <div class="fishing-water">
            <span class="fishing-bob" id="bcBob">🎣</span>
            <span class="fishing-catch" id="bcCatch"></span>
          </div>
          <div class="fishing-ripple" id="bcRipple"></div>
        </div>
        <div class="crash-status" id="bcStatus">Cast your line to fish.</div>`, 'bigcatch-stage');

    const betInput = container.querySelector('#bcBet');
    const cast = container.querySelector('#bcCast');
    const bob = container.querySelector('#bcBob');
    const catchEl = container.querySelector('#bcCatch');
    const ripple = container.querySelector('#bcRipple');
    const statusEl = container.querySelector('#bcStatus');
    const lastEl = container.querySelector('#bcLast');
    GameKit.wireBet(container, betInput);

    cast.addEventListener('click', async () => {
      if (busy) return;
      const b = GameKit.bet(betInput);
      if (b == null) return;
      busy = true; cast.disabled = true;
      catchEl.textContent = ''; catchEl.className = 'fishing-catch';
      bob.classList.add('cast');
      ripple.classList.add('active');
      statusEl.textContent = 'Line in the water…';
      try {
        const res = await API.bigcatch({ bet: b });
        // Suspense: bob dips a few times before the catch surfaces.
        timers.push(setTimeout(() => { if (alive) { bob.classList.add('nibble'); statusEl.textContent = 'Something\'s biting…'; } }, 700));
        timers.push(setTimeout(() => { if (alive) { bob.classList.add('nibble'); } }, 1200));
        timers.push(setTimeout(() => {
          if (!alive) return;
          bob.classList.remove('cast', 'nibble');
          ripple.classList.remove('active');
          catchEl.textContent = res.emoji;
          catchEl.classList.add('surfaced');
          if (res.mult >= 40) catchEl.classList.add('monster');
          lastEl.textContent = res.mult > 0 ? res.mult + '×' : '—';
          statusEl.textContent = res.mult >= 40 ? `🐋 THE WHALE! ${res.mult}×!!`
            : res.mult >= 1 ? `${res.name} — ${res.mult}×!`
            : `Just a ${res.name}. Cast again.`;
          GameKit.settle('bigcatch', b, res);
          timers.push(setTimeout(() => { if (alive) { busy = false; cast.disabled = false; } }, 1400));
        }, 1700));
      } catch (e) { Toast.error(e.message); busy = false; cast.disabled = false; bob.classList.remove('cast', 'nibble'); ripple.classList.remove('active'); }
    });

    return function () { alive = false; timers.forEach(clearTimeout); };
  }
  global.Games = global.Games || {};
  global.Games.bigcatch = mount;
})(window);
