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

    // Data
    history: (n)           => request('GET', '/api/history?limit=' + (n || 30)),
    stats:   ()            => request('GET', '/api/stats')
  };
})(window);
