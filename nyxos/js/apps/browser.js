import { registerApp } from '../core/registry.js';
import { el } from '../core/util.js';
import { icon } from '../core/icons.js';
import { State } from '../core/state.js';
import { bigButton } from '../shell/kit.js';

const LOCAL = {
  'about:nyxos': { title: 'NyxOS', body: 'NyxOS is a privacy-first phone OS. This browser blocks third-party trackers, sends no referrer, and cannot reach the network unless you grant it the Network permission.' },
  'about:privacy': { title: 'Privacy', body: 'Every app runs in its own sandbox with per-app permissions. Network access is a permission you can revoke. Traffic can be routed Direct, through a VPN, or over Tor from the quick settings.' },
  'about:help': { title: 'Help', body: 'Type a URL and press Go. Try about:nyxos or about:privacy. If the network is blocked, grant Browser the Network permission from this page or from Privacy → Permissions.' },
};

registerApp({
  id: 'browser', name: 'Browser', icon: 'browser', color: '#8be9a0', order: 60, dock: true, perms: ['network'], chrome: false,
  mount(root, sys, ctx) {
    const history = [];
    const input = el('input', { attrs: { type: 'text', inputmode: 'url', placeholder: 'Search or enter address' } });
    const view = el('div', { class: 'browser-view' });

    const bar = el('div', { class: 'browser-bar' },
      el('button', { attrs: { 'aria-label': 'Back' }, html: icon('back'), on: { click: goBack } }),
      el('div', { class: 'url' }, el('span', { html: icon('lock') }), input),
      el('button', { attrs: { 'aria-label': 'Go' }, html: icon('forward'), on: { click: () => go(input.value) } }),
    );
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(input.value); });

    function goBack() { if (history.length > 1) { history.pop(); const prev = history.pop(); go(prev, false); } else ctx.close(); }

    function renderHome() {
      input.value = '';
      const routing = State.get('toggles.routing', 'direct');
      const sc = el('div', { class: 'shortcuts' });
      for (const key of Object.keys(LOCAL)) {
        sc.append(el('button', { class: 'file-tile', on: { click: () => go(key) } },
          el('div', { html: icon('globe') }), el('div', { class: 'fname', text: LOCAL[key].title })));
      }
      view.replaceChildren(el('div', { class: 'browser-home' },
        el('div', { style: { display: 'grid', placeItems: 'center', color: 'var(--accent)', margin: '10px 0' }, html: icon('shieldCheck') }),
        el('h2', { text: 'Private browsing' }),
        el('p', { class: 'hint', text: `Trackers blocked · no referrer · routing: ${routing === 'direct' ? 'Direct' : routing.toUpperCase()}` }),
        sc));
    }

    function renderBlocked(url) {
      view.replaceChildren(el('div', { class: 'empty-state' },
        el('div', { html: icon('networkOff') }),
        el('h3', { text: 'Network blocked' }),
        el('p', { class: 'hint', text: `Browser does not have the Network permission, so it cannot load ${url}.` }),
        el('div', { style: { marginTop: '14px' } }, bigButton('Allow network for Browser', { kind: 'primary', icon: 'network', onClick: async () => { const ok = await sys.perms.request('network'); if (ok) go(url); } }))));
    }

    async function go(raw, push = true) {
      let url = (raw || '').trim();
      if (!url) return renderHome();
      if (LOCAL[url]) { input.value = url; if (push) history.push(url); const p = LOCAL[url]; view.replaceChildren(el('div', { style: { padding: '6px' } }, el('h2', { text: p.title }), el('p', { style: { color: 'var(--text-dim)', lineHeight: '1.6', marginTop: '10px' }, text: p.body }))); return; }
      if (!/^https?:\/\//i.test(url)) { if (url.includes('.') && !url.includes(' ')) url = 'https://' + url; else url = 'https://duckduckgo.com/html/?q=' + encodeURIComponent(url); }
      input.value = url; if (push) history.push(url);

      if (!sys.net.allowed()) return renderBlocked(url);
      view.replaceChildren(el('div', { class: 'browser-home' }, el('p', { class: 'hint', text: 'Loading ' + url + ' …' })));
      try {
        const res = await sys.net.fetch(url);
        const text = await res.text();
        const pre = el('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '13px', lineHeight: '1.5', color: 'var(--text-dim)' } });
        pre.textContent = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 4000);
        view.replaceChildren(el('div', { class: 'badge-pill live', text: `${res.status} · ${url}`, style: { marginBottom: '10px', display: 'inline-block' } }), pre);
      } catch (e) {
        view.replaceChildren(el('div', { class: 'empty-state' }, el('div', { html: icon('alert') }), el('h3', { text: 'Could not load' }), el('p', { class: 'hint', text: e.name === 'PermissionDenied' ? 'Network permission denied.' : 'The page failed to load (offline, blocked, or CORS-restricted).' })));
      }
    }

    root.append(el('div', { class: 'browser' }, bar, view));
    renderHome();
  },
});
