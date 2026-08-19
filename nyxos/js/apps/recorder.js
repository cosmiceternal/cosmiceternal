import { registerApp } from '../core/registry.js';
import { el, pad2 } from '../core/util.js';
import { icon } from '../core/icons.js';
import { bigButton, list, row } from '../shell/kit.js';

registerApp({
  id: 'recorder', name: 'Recorder', icon: 'mic', color: '#ff8fb0', order: 120, optional: true, perms: ['microphone'],
  desc: 'A voice recorder — demonstrates the Microphone permission. Recordings are stored in the app’s own encrypted scope.',
  mount(root, sys, ctx) {
    ctx.setTitle('Recorder');
    let rec = null, chunks = [], stream = null, t0 = 0, tick = null;
    const load = () => sys.storage.get('clips', []);
    const save = (c) => sys.storage.set('clips', c);
    const cleanup = () => { try { rec?.state === 'recording' && rec.stop(); } catch {} stream?.getTracks().forEach((x) => x.stop()); clearInterval(tick); };
    ctx.onCleanup(cleanup);

    const render = () => {
      if (!sys.perms.granted('microphone')) {
        return root.replaceChildren(el('div', { class: 'empty-state' },
          el('div', { html: icon('mic') }), el('h3', { text: 'Microphone permission needed' }),
          el('p', { class: 'hint', text: 'NyxOS blocks the microphone until you allow it for this app.' }),
          el('div', { style: { marginTop: '14px' } }, bigButton('Allow microphone', { kind: 'primary', icon: 'mic', onClick: async () => { if (await sys.perms.request('microphone')) render(); } }))));
      }
      const timer = el('div', { class: 'stopwatch-time', text: '00:00' });
      const btn = bigButton('Record', { kind: 'danger', icon: 'mic', onClick: toggle });
      const clips = load();
      const clipList = clips.length ? list(...clips.map((c) => row({
        icon: 'play', iconColor: '#ff8fb0', title: c.name, sub: `${c.dur}s`,
        onClick: () => { const a = new Audio(c.data); a.play(); },
      }))) : el('div', { class: 'hint', text: 'No recordings yet.' });
      root.replaceChildren(el('div', { style: { textAlign: 'center' } }, timer, el('div', { style: { marginTop: '14px' } }, btn)),
        el('div', { class: 'section-title', text: 'Recordings' }), clipList);

      async function toggle() {
        if (rec && rec.state === 'recording') { rec.stop(); clearInterval(tick); return; }
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          rec = new MediaRecorder(stream); chunks = []; t0 = Date.now();
          rec.ondataavailable = (e) => chunks.push(e.data);
          rec.onstop = () => {
            const dur = Math.round((Date.now() - t0) / 1000);
            const blob = new Blob(chunks, { type: 'audio/webm' });
            const fr = new FileReader();
            fr.onload = () => { const c = load(); c.unshift({ id: Date.now(), name: 'Clip ' + (c.length + 1), dur, data: fr.result }); if (c.length > 20) c.length = 20; save(c); render(); };
            fr.readAsDataURL(blob);
            stream.getTracks().forEach((x) => x.stop());
          };
          rec.start();
          btn.querySelector('span:last-child').textContent = 'Stop';
          tick = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); timer.textContent = `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`; }, 250);
        } catch {
          sys.toast('No microphone available here', { icon: 'micOff' });
        }
      }
    };
    render();
  },
});
