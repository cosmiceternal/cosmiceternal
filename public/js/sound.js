/* Sound — a richer WebAudio synth, still zero audio assets. Everything is
 * generated from oscillators and filtered noise so the repo stays
 * dependency-free, but the palette is layered and musical (real note
 * frequencies, chords, a little reverb on the celebratory cues) so it feels
 * like a casino, not a beeper. Muted state persists; the AudioContext is
 * created lazily on the first user gesture. */
(function (global) {
  'use strict';

  let ctx = null, master = null, reverb = null, wet = null;
  let muted = false;
  try { muted = localStorage.getItem('crypt.muted') === '1'; } catch (_) {}

  // Equal-temperament note table (Hz).
  const N = {
    C3: 130.81, E3: 164.81, G3: 196.00,
    C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.00, A4: 440.00, B4: 493.88,
    C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.00,
    C6: 1046.50, E6: 1318.51, G6: 1567.98, C7: 2093.00
  };

  function ac() {
    if (!ctx) {
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
      // Lightweight generated-impulse reverb bus for celebratory cues.
      try {
        reverb = ctx.createConvolver();
        const len = Math.floor(ctx.sampleRate * 1.1);
        const buf = ctx.createBuffer(2, len, ctx.sampleRate);
        for (let ch = 0; ch < 2; ch++) {
          const d = buf.getChannelData(ch);
          for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.4);
        }
        reverb.buffer = buf;
        wet = ctx.createGain(); wet.gain.value = 0.22;
        reverb.connect(wet).connect(master);
      } catch (_) { reverb = null; }
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  // One enveloped oscillator note. `send` routes a copy into the reverb bus.
  function tone(freq, { type = 'sine', at = 0, dur = 0.14, gain = 0.16, slide = 0, send = 0 } = {}) {
    const a = ac(); if (!a) return;
    const t0 = a.currentTime + at;
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(master);
    if (send && reverb) { const s = a.createGain(); s.gain.value = send; g.connect(s).connect(reverb); }
    osc.start(t0);
    osc.stop(t0 + dur + 0.06);
  }
  // Two detuned oscillators for a fuller "chorus" note.
  function fat(freq, opts = {}) {
    tone(freq, opts);
    tone(freq * 1.005, Object.assign({}, opts, { gain: (opts.gain || 0.16) * 0.6 }));
  }
  // Short filtered-noise burst (clacks, flicks, whooshes).
  function noise({ at = 0, dur = 0.05, gain = 0.1, freq = 2400, q = 1.2, type = 'bandpass', sweep = 0 } = {}) {
    const a = ac(); if (!a) return;
    const t0 = a.currentTime + at;
    const len = Math.max(1, Math.floor(a.sampleRate * dur));
    const buf = a.createBuffer(1, len, a.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = a.createBufferSource(); src.buffer = buf;
    const bp = a.createBiquadFilter(); bp.type = type; bp.frequency.setValueAtTime(freq, t0); bp.Q.value = q;
    if (sweep) bp.frequency.exponentialRampToValueAtTime(Math.max(80, freq + sweep), t0 + dur);
    const g = a.createGain(); g.gain.value = gain;
    src.connect(bp).connect(g).connect(master);
    src.start(t0);
  }

  const FX = {
    // --- UI ---
    nav:    () => { tone(N.A5, { type: 'sine', dur: 0.06, gain: 0.05 }); tone(N.E5, { at: 0.005, dur: 0.05, gain: 0.04 }); },
    click:  () => { noise({ dur: 0.025, gain: 0.06, freq: 3000 }); tone(N.C6, { type: 'sine', dur: 0.03, gain: 0.04 }); },
    tick:   () => noise({ dur: 0.02, gain: 0.05, freq: 2600, q: 2 }),
    // --- Wagers ---
    chip:   () => { noise({ dur: 0.035, gain: 0.09, freq: 2000 }); noise({ at: 0.045, dur: 0.03, gain: 0.07, freq: 2500 }); tone(N.G5, { at: 0.01, type: 'sine', dur: 0.04, gain: 0.04 }); },
    card:   () => noise({ dur: 0.06, gain: 0.09, freq: 1600, q: 0.8, type: 'highpass', sweep: 1200 }),
    spin:   () => noise({ dur: 0.5, gain: 0.07, freq: 400, q: 0.9, sweep: 1400 }),
    reveal: () => { tone(N.C5, { type: 'sine', dur: 0.28, gain: 0.1, slide: 700, send: 0.3 }); tone(N.G5, { at: 0.05, type: 'triangle', dur: 0.2, gain: 0.06, send: 0.3 }); },
    // --- Outcomes ---
    win:    () => { [N.C5, N.E5, N.G5].forEach((f, i) => fat(f, { at: i * 0.07, type: 'triangle', dur: 0.16, gain: 0.15, send: 0.25 })); tone(N.C6, { at: 0.2, type: 'sine', dur: 0.2, gain: 0.12, send: 0.3 }); },
    bigwin: () => {
      [N.C5, N.E5, N.G5].forEach(f => fat(f, { type: 'triangle', dur: 0.5, gain: 0.12, send: 0.3 }));   // chord stab
      [N.E5, N.G5, N.C6, N.E6].forEach((f, i) => tone(f, { at: 0.14 + i * 0.09, type: 'sine', dur: 0.24, gain: 0.14, send: 0.35 }));
    },
    loss:   () => { tone(N.G4, { type: 'triangle', dur: 0.18, gain: 0.09 }); tone(N.D4, { at: 0.12, type: 'triangle', dur: 0.24, gain: 0.08, slide: -40 }); },
    level:  () => { [N.G4, N.C5, N.E5, N.G5].forEach((f, i) => tone(f, { at: i * 0.1, type: 'triangle', dur: 0.18, gain: 0.15, send: 0.25 })); },
    cashout:() => { tone(N.E5, { type: 'sine', dur: 0.1, gain: 0.14 }); tone(N.G5, { at: 0.02, type: 'sine', dur: 0.1, gain: 0.12 }); tone(N.C6, { at: 0.11, type: 'sine', dur: 0.22, gain: 0.14, send: 0.3 }); },
    jackpot:() => {
      tone(N.C3, { type: 'sine', dur: 0.7, gain: 0.14 });                                                // low boom
      [N.C5, N.E5, N.G5, N.C6, N.E6, N.G6].forEach((f, i) => tone(f, { at: i * 0.1, type: 'sine', dur: 0.3, gain: 0.16, send: 0.4 }));
      [N.G6, N.C7].forEach((f, i) => tone(f, { at: 0.7 + i * 0.14, type: 'triangle', dur: 0.4, gain: 0.12, send: 0.5 }));
    }
  };

  function play(name) {
    if (muted) return;
    const fn = FX[name] || FX.click;
    try { fn(); } catch (_) { /* audio is never worth an error */ }
  }
  function toggleMute() {
    muted = !muted;
    try { localStorage.setItem('crypt.muted', muted ? '1' : '0'); } catch (_) {}
    return muted;
  }

  global.Sound = { play, toggleMute, isMuted: () => muted, has: (n) => !!FX[n] };
})(window);
