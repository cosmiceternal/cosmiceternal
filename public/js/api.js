/* Thin fetch wrapper for the NEONSTAKE backend. Same-origin, cookie session. */
(function (global) {
  'use strict';

  async function request(method, path, body) {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  global.API = {
    get:  (p)    => request('GET', p),
    post: (p, b) => request('POST', p, b),

    // Auth
    me:       ()           => request('GET', '/api/me'),
    register: (u, p)       => request('POST', '/api/auth/register', { username: u, password: p }),
    login:    (u, p)       => request('POST', '/api/auth/login', { username: u, password: p }),
    logout:   ()           => request('POST', '/api/auth/logout'),

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
    bjStart:      (b)      => request('POST', '/api/play/blackjack/start', b),
    bjHit:        (b)      => request('POST', '/api/play/blackjack/hit', b),
    bjStand:      (b)      => request('POST', '/api/play/blackjack/stand', b),
    bjDouble:     (b)      => request('POST', '/api/play/blackjack/double', b),

    // Data
    history: (n)           => request('GET', '/api/history?limit=' + (n || 30)),
    stats:   ()            => request('GET', '/api/stats')
  };
})(window);
