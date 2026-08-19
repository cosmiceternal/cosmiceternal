import { registerApp } from '../core/registry.js';
import { el, fmtClock } from '../core/util.js';
import { icon } from '../core/icons.js';

// A tiny simulated messenger. Its point is to generate real (and sensitive)
// notifications so the shade and the lock-screen "hide sensitive content"
// behaviour are demonstrable. Fully offline — the "replies" are canned.
const REPLIES = [
  'Sounds good 👍', 'On my way.', 'Haha, for real.', 'Can you send that over?',
  'Let’s do tonight.', 'Nice — thanks!', 'I’ll check and get back to you.',
];

registerApp({
  id: 'messages', name: 'Messages', icon: 'chat', color: '#7aa2ff', order: 115, optional: true,
  desc: 'A simple messenger — generates sensitive notifications to show the lock-screen privacy controls.',
  mount(root, sys, ctx) {
    ctx.setTitle('Messages · Alex');
    const load = () => sys.storage.get('thread', [
      { from: 'them', text: 'Hey — are we still on for tonight?', ts: Date.now() - 3600000 },
    ]);
    const save = (m) => sys.storage.set('thread', m);

    const thread = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', paddingBottom: '8px' } });
    const paint = () => {
      const msgs = load();
      thread.replaceChildren(...msgs.map((m) => el('div', {
        style: {
          alignSelf: m.from === 'me' ? 'flex-end' : 'flex-start',
          maxWidth: '78%', padding: '9px 13px', borderRadius: '16px', fontSize: '14px',
          background: m.from === 'me' ? 'var(--accent)' : 'var(--surface-2)',
          color: m.from === 'me' ? 'var(--accent-ink)' : 'var(--text)',
        },
      }, m.text)));
      thread.scrollIntoView?.({ block: 'end' });
      root.scrollTo?.(0, root.scrollHeight);
    };

    const input = el('input', { class: 'field', style: { marginTop: '0' }, attrs: { placeholder: 'Message' } });
    const send = el('button', { class: 'btn btn-primary', style: { padding: '11px 14px' }, html: icon('send'), on: { click: fire } });
    const bar = el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', position: 'sticky', bottom: '0', background: 'var(--bg-1)', paddingTop: '8px' } }, input, send);

    function fire() {
      const text = input.value.trim();
      if (!text) return;
      const msgs = load(); msgs.push({ from: 'me', text, ts: Date.now() }); save(msgs); input.value = ''; paint();
      setTimeout(() => {
        const reply = REPLIES[Math.floor(Math.random() * REPLIES.length)];
        const m = load(); m.push({ from: 'them', text: reply, ts: Date.now() }); save(m); paint();
        sys.notify({ title: 'Alex', text: reply, icon: 'chat', color: '#7aa2ff', sensitive: true });
      }, 900);
    }
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') fire(); });

    root.append(thread, bar);
    paint();
  },
});
