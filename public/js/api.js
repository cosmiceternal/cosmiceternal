/* Thin fetch wrapper for the NEONSTAKE backend. Same-origin, cookie session. */
(function (global) {
  'use strict';

  function getCsrf() {
    const m = document.cookie.match(/(?:^|;\s*)csrf=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  async function request(method, path, body, opts) {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && method !== 'HEAD') {
      const t = getCsrf();
      if (t) headers['X-CSRF-Token'] = t;
    }
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: opts && opts.signal
    });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    // Auto-apply any progression delta the server attached. Defined in
    // progression.js which loads after api.js, so it's safe at request time.
    if (data && data.progress && global.Progression) {
      try { global.Progression.apply(data.progress); }
      catch (e) { console.warn('Progression.apply failed:', e); }
    }
    return data;
  }

  global.API = {
    get:  (p)    => request('GET', p),
    post: (p, b) => request('POST', p, b),

    // Auth
    me:             ()       => request('GET', '/api/me'),
    register:       (u, p)   => request('POST', '/api/auth/register', { username: u, password: p }),
    login:          (u, p)   => request('POST', '/api/auth/login', { username: u, password: p }),
    logout:         ()       => request('POST', '/api/auth/logout'),
    changePassword: (cur, n) => request('POST', '/api/auth/password', { current: cur, next: n }),
    auditLog:       (n)      => request('GET', '/api/auth/audit?limit=' + (n || 25)),

    // Progression
    progression:    ()     => request('GET', '/api/progression'),
    claimDaily:     ()     => request('POST', '/api/progression/claim-daily'),

    // Fair
    fair:        ()        => request('GET', '/api/fair'),
    fairHistory: (n)       => request('GET', '/api/fair/history?limit=' + (n || 30)),
    setClient:   (seed)    => request('POST', '/api/fair/client', { clientSeed: seed }),
    rotate:      ()        => request('POST', '/api/fair/rotate'),

    // Games
    dice:         (b)      => request('POST', '/api/play/dice', b),
    plinko:       (b)      => request('POST', '/api/play/plinko', b),
    crash:        (b)      => request('POST', '/api/play/crash', b),
    minesStart:   (b)      => request('POST', '/api/play/mines/start', b),
    minesReveal:  (b)      => request('POST', '/api/play/mines/reveal', b),
    minesCashout: (b)      => request('POST', '/api/play/mines/cashout', b),
    limbo:        (b)      => request('POST', '/api/play/limbo', b),
    wheel:        (b)      => request('POST', '/api/play/wheel', b),
    keno:         (b)      => request('POST', '/api/play/keno', b),
    kenoTable:    (n)      => request('GET', '/api/play/keno/table?picks=' + n),
    roulette:     (b)      => request('POST', '/api/play/roulette', b),
    diamonds:     (b)      => request('POST', '/api/play/diamonds', b),
    slots:        (b)      => request('POST', '/api/play/slots', b),
    luckySevens:  (b)      => request('POST', '/api/play/luckysevens', b),
    cosmicReels:  (b)      => request('POST', '/api/play/cosmic', b),
    sicbo:        (b)      => request('POST', '/api/play/sicbo', b),
    color:        (b)      => request('POST', '/api/play/color', b),
    scratch:      (b)      => request('POST', '/api/play/scratch', b),
    hiloStart:    (b)      => request('POST', '/api/play/hilo/start', b),
    hiloGuess:    (b)      => request('POST', '/api/play/hilo/guess', b),
    hiloCashout:  (b)      => request('POST', '/api/play/hilo/cashout', b),
    towersStart:   (b)     => request('POST', '/api/play/towers/start', b),
    towersReveal:  (b)     => request('POST', '/api/play/towers/reveal', b),
    towersCashout: (b)     => request('POST', '/api/play/towers/cashout', b),
    pumpStart:    (b)      => request('POST', '/api/play/pump/start', b),
    pumpPump:     (b)      => request('POST', '/api/play/pump/pump', b),
    pumpCashout:  (b)      => request('POST', '/api/play/pump/cashout', b),
    coinStart:    (b)      => request('POST', '/api/play/coin/start', b),
    coinFlip:     (b)      => request('POST', '/api/play/coin/flip', b),
    coinCashout:  (b)      => request('POST', '/api/play/coin/cashout', b),
    vpStart:      (b)      => request('POST', '/api/play/videopoker/start', b),
    vpDraw:       (b)      => request('POST', '/api/play/videopoker/draw', b),
    dealerLine: (b, opts)  => request('POST', '/api/dealer/line', b, opts),
    bjStart:      (b)      => request('POST', '/api/play/blackjack/start', b),
    bjHit:        (b)      => request('POST', '/api/play/blackjack/hit', b),
    bjStand:      (b)      => request('POST', '/api/play/blackjack/stand', b),
    bjDouble:     (b)      => request('POST', '/api/play/blackjack/double', b),
    baccarat:     (b)      => request('POST', '/api/play/baccarat', b),
    dragontiger:  (b)      => request('POST', '/api/play/dragontiger', b),
    andarbahar:   (b)      => request('POST', '/api/play/andarbahar', b),
    cascade:      (b)      => request('POST', '/api/play/cascade', b),
    war:          (b)      => request('POST', '/api/play/war', b),
    pachinko:     (b)      => request('POST', '/api/play/pachinko', b),
    penaltyStart:   (b)    => request('POST', '/api/play/penalty/start', b),
    penaltyShoot:   (b)    => request('POST', '/api/play/penalty/shoot', b),
    penaltyCashout: (b)    => request('POST', '/api/play/penalty/cashout', b),

    // Data
    history:    (n)        => request('GET', '/api/history?limit=' + (n || 30)),
    stats:      ()         => request('GET', '/api/stats'),
    globalFeed: (n, mp)    => request('GET', '/api/feed/global?limit=' + (n || 30) + (mp ? '&min_payout_cents=' + mp : '')),
    leaderboard:(metric, n)=> request('GET', '/api/leaderboard?metric=' + (metric || 'xp') + '&limit=' + (n || 10)),

    // Vault (crypto deposits)
    vault:           ()     => request('GET',  '/api/vault'),
    createDeposit:   (b)    => request('POST', '/api/vault/deposit', b),
    confirmDeposit:  (b)    => request('POST', '/api/vault/confirm', b),
    cancelDeposit:   (b)    => request('POST', '/api/vault/cancel',  b),
    listDeposits:    (n)    => request('GET',  '/api/vault/history?limit=' + (n || 25))
  };
})(window);
