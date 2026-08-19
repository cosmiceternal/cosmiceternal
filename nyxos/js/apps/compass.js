import { registerApp } from '../core/registry.js';
import { el } from '../core/util.js';
import { icon } from '../core/icons.js';
import { State } from '../core/state.js';
import { bigButton } from '../shell/kit.js';

registerApp({
  id: 'compass', name: 'Compass', icon: 'location', color: '#c58cff', order: 110, optional: true, perms: ['sensors'],
  desc: 'A compass that reads the magnetometer — a clean demo of the Sensors permission and the global sensors kill-switch.',
  mount(root, sys, ctx) {
    ctx.setTitle('Compass');
    let stop = null;
    ctx.onCleanup(() => stop?.());

    const render = () => {
      stop?.(); stop = null;
      const sensorsOff = State.get('security.sensorsGlobal', true) === false;

      if (!sys.perms.granted('sensors')) {
        return root.replaceChildren(el('div', { class: 'empty-state' },
          el('div', { html: icon('sensor') }), el('h3', { text: 'Sensors permission needed' }),
          el('p', { class: 'hint', text: 'Compass needs the Sensors permission to read orientation.' }),
          el('div', { style: { marginTop: '14px' } }, bigButton('Allow sensors', { kind: 'primary', icon: 'sensor', onClick: async () => { if (await sys.perms.request('sensors')) render(); } }))));
      }
      if (sensorsOff) {
        return root.replaceChildren(el('div', { class: 'empty-state' },
          el('div', { html: icon('sensor') }), el('h3', { text: 'Sensors are globally off' }),
          el('p', { class: 'hint', text: 'The system Sensors switch (quick settings) is blocking all sensor access — even for apps you granted. Turn it on to use the compass.' })));
      }

      const heading = el('div', { style: { fontSize: '40px', fontWeight: '300', textAlign: 'center' }, text: '—' });
      const dial = el('div', { style: { width: '220px', height: '220px', margin: '20px auto', borderRadius: '50%', border: '2px solid var(--border)', position: 'relative', background: 'var(--surface)' } });
      const needle = el('div', { style: { position: 'absolute', top: '10px', left: '50%', width: '4px', height: '100px', background: 'var(--accent)', transformOrigin: 'bottom center', transform: 'translateX(-50%)', borderRadius: '4px' } });
      const north = el('div', { style: { position: 'absolute', top: '6px', left: '50%', transform: 'translateX(-50%)', color: 'var(--danger)', fontWeight: '700', fontSize: '12px' }, text: 'N' });
      dial.append(needle, north);
      root.replaceChildren(heading, dial, el('div', { class: 'hint', text: 'Rotate your device. On hardware without a magnetometer the needle stays put — the permission is still enforced.' }));

      try {
        stop = sys.sensors.start(({ alpha }) => {
          if (alpha == null) return;
          heading.textContent = Math.round(alpha) + '°';
          needle.style.transform = `translateX(-50%) rotate(${-alpha}deg)`;
        });
      } catch { /* denied between checks */ }
    };
    render();
    const off = State.events.on('change', (p) => { if (p === 'security.sensorsGlobal') render(); });
    ctx.onCleanup(off);
  },
});
