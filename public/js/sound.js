/* Sound — tiny WebAudio synth, no audio assets. Every effect is generated
 * from oscillators so the repo stays dependency-free. Muted state persists
 * in localStorage; the AudioContext is created lazily on first user gesture
 * (browsers block autoplay before interaction). */
(function (global) {
  'use strict';

  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem('crypt.muted') === '1'; } catch (_) {}

  function ac() {
    if (!ctx) {
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  // One enveloped oscillator note.
  function tone(freq, { type = 'sine', at = 0, dur = 0.12, gain = 0.16, slide = 0 } = {}) {
    const a = ac();
    if (!a) return;
    const t0 = a.currentTime + at;
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(a.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }
  // Short filtered-noise burst (chip clack / card snap).
  function noise({ at = 0, dur = 0.05, gain = 0.1, freq = 2400 } = {}) {
    const a = ac();
    if (!a) return;
    const t0 = a.currentTime + at;
    const len = Math.max(1, Math.floor(a.sampleRate * dur));
    const buf = a.createBuffer(1, len, a.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = a.createBufferSource();
    src.buffer = buf;
    const bp = a.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 1.2;
    const g = a.createGain(); g.gain.value = gain;
    src.connect(bp).connect(g).connect(a.destination);
    src.start(t0);
  }

  const FX = {
    click:  () => noise({ dur: 0.03, gain: 0.07, freq: 3200 }),
    chip:   () => { noise({ dur: 0.04, gain: 0.09, freq: 2100 }); noise({ at: 0.05, dur: 0.03, gain: 0.06, freq: 2600 }); },
    win:    () => { tone(523, { at: 0,    dur: 0.11 }); tone(659, { at: 0.09, dur: 0.11 }); tone(784, { at: 0.18, dur: 0.16, gain: 0.18 }); },
    bigwin: () => { [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, { at: i * 0.08, dur: 0.14, gain: 0.18, type: 'triangle' })); },
    loss:   () => tone(196, { dur: 0.18, gain: 0.10, type: 'triangle', slide: -60 }),
    level:  () => { tone(392, { at: 0, dur: 0.1 }); tone(523, { at: 0.1, dur: 0.1 }); tone(659, { at: 0.2, dur: 0.2, gain: 0.2 }); },
    jackpot:() => {
      [523, 659, 784, 1046].forEach((f, i) => tone(f, { at: i * 0.09, dur: 0.16, gain: 0.2, type: 'square' }));
      [1318, 1568, 2093].forEach((f, i) => tone(f, { at: 0.4 + i * 0.11, dur: 0.24, gain: 0.16, type: 'triangle' }));
    }
  };

  function play(name) {
    if (muted) return;
    const fn = FX[name];
    if (!fn) return;
    try { fn(); } catch (_) { /* audio is never worth an error */ }
  }
  function toggleMute() {
    muted = !muted;
    try { localStorage.setItem('crypt.muted', muted ? '1' : '0'); } catch (_) {}
    return muted;
  }

  global.Sound = { play, toggleMute, isMuted: () => muted };
})(window);
