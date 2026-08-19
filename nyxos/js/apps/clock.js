import { registerApp } from '../core/registry.js';
import { el, fmtClock, fmtDate, pad2 } from '../core/util.js';
import { segmented, bigButton, list, row } from '../shell/kit.js';

function clockView(root, ctx) {
  const big = el('div', { class: 'clock-big' });
  const sub = el('div', { class: 'clock-sub' });
  const tz = el('div', { class: 'clock-sub', style: { marginTop: '2px', fontSize: '12px', color: 'var(--text-mute)' } });
  const paint = () => {
    const d = new Date();
    big.textContent = fmtClock(d) + ':' + pad2(d.getSeconds());
    sub.textContent = fmtDate(d);
    tz.textContent = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  };
  paint();
  const id = setInterval(paint, 1000);
  ctx.onCleanup(() => clearInterval(id));
  root.append(el('div', { class: 'clock-face' }, big, sub, tz));
}

function stopwatchView(root, ctx) {
  let start = 0, elapsed = 0, running = false, laps = [];
  const disp = el('div', { class: 'stopwatch-time', text: '00:00.00' });
  const lapList = el('div', { class: 'list lap-list', style: { marginTop: '12px' } });
  const fmt = (ms) => {
    const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000), cs = Math.floor((ms % 1000) / 10);
    return `${pad2(m)}:${pad2(s)}.${pad2(cs)}`;
  };
  const paint = () => { disp.textContent = fmt(elapsed + (running ? Date.now() - start : 0)); };
  const id = setInterval(() => { if (running) paint(); }, 33);
  ctx.onCleanup(() => clearInterval(id));

  const startBtn = bigButton('Start', { kind: 'primary', onClick: () => {
    if (running) { elapsed += Date.now() - start; running = false; startBtn.querySelector('span:last-child').textContent = 'Start'; startBtn.classList.add('btn-primary'); }
    else { start = Date.now(); running = true; startBtn.querySelector('span:last-child').textContent = 'Stop'; startBtn.classList.remove('btn-primary'); startBtn.classList.add('btn-danger'); }
    paint();
  } });
  const lapBtn = bigButton('Lap', { onClick: () => {
    const total = elapsed + (running ? Date.now() - start : 0);
    laps.unshift(total);
    lapList.replaceChildren(...laps.map((t, i) => row({ title: `Lap ${laps.length - i}`, value: fmt(t) })));
  } });
  const resetBtn = bigButton('Reset', { onClick: () => { running = false; elapsed = 0; laps = []; lapList.replaceChildren(); startBtn.querySelector('span:last-child').textContent = 'Start'; startBtn.classList.remove('btn-danger'); startBtn.classList.add('btn-primary'); paint(); } });

  root.append(disp, el('div', { class: 'btn-row' }, resetBtn, startBtn, lapBtn), lapList);
}

function timerView(root, ctx, sys) {
  let remaining = 0, running = false, endAt = 0;
  const disp = el('div', { class: 'stopwatch-time' });
  const input = el('input', { class: 'field', attrs: { type: 'number', min: '1', placeholder: 'Minutes' }, style: { textAlign: 'center' } });
  const fmt = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`; };
  const paint = () => { disp.textContent = fmt(running ? endAt - Date.now() : remaining); };
  const id = setInterval(() => {
    if (running && Date.now() >= endAt) {
      running = false; remaining = 0; paint();
      sys.notify({ title: 'Timer finished', text: 'Your countdown is complete', icon: 'clock' });
      sys.toast('Timer finished', { type: 'ok', icon: 'clock' });
    } else if (running) paint();
  }, 250);
  ctx.onCleanup(() => clearInterval(id));

  const startBtn = bigButton('Start', { kind: 'primary', onClick: () => {
    if (running) { running = false; remaining = endAt - Date.now(); }
    else { const mins = parseFloat(input.value) || (remaining ? remaining / 60000 : 1); remaining = remaining || mins * 60000; endAt = Date.now() + remaining; running = true; }
    startBtn.querySelector('span:last-child').textContent = running ? 'Pause' : 'Resume'; paint();
  } });
  remaining = 60000; paint();
  root.append(el('div', { style: { textAlign: 'center' } }, disp), input, el('div', { style: { marginTop: '12px' } }, startBtn));
}

registerApp({
  id: 'clock', name: 'Clock', icon: 'clock', color: '#7aa2ff', order: 10,
  mount(root, sys, ctx) {
    const { el: view } = segmented([
      { name: 'Clock', render: (c) => clockView(c, ctx) },
      { name: 'Stopwatch', render: (c) => stopwatchView(c, ctx) },
      { name: 'Timer', render: (c) => timerView(c, ctx, sys) },
    ]);
    root.append(view);
  },
});
