import { registerApp } from '../core/registry.js';
import { el } from '../core/util.js';
import { icon } from '../core/icons.js';
import { State } from '../core/state.js';
import { allApps, isInstalled, setInstalled } from '../core/registry.js';
import { toggleRow, section, list } from '../shell/kit.js';

registerApp({
  id: 'store', name: 'App Store', icon: 'store', color: '#8be9a0', order: 80, dock: false,
  mount(root, sys, ctx) {
    ctx.setTitle('App Store');

    const card = (app) => {
      const installed = isInstalled(app.id);
      const btn = el('button', { class: 'sc-btn' + (installed ? ' installed' : '') });
      const setLabel = () => { const on = isInstalled(app.id); btn.textContent = app.system ? 'System' : on ? 'Open' : 'Get'; btn.classList.toggle('installed', on); };
      setLabel();
      btn.addEventListener('click', () => {
        if (app.system || isInstalled(app.id)) { sys.openApp(app.id); return; }
        setInstalled(app.id, true); sys.toast(`${app.name} installed`, { type: 'ok', icon: 'download' }); render();
      });
      const actions = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-end' } }, btn);
      if (!app.system && isInstalled(app.id) && app.optional) {
        actions.append(el('button', { style: { fontSize: '11px', color: 'var(--text-mute)' }, text: 'Uninstall', on: { click: () => { setInstalled(app.id, false); sys.toast(`${app.name} removed`); render(); } } }));
      }
      return el('div', { class: 'list' }, el('div', { class: 'store-card' },
        el('div', { class: 'app-icon', style: { background: app.color }, html: icon(app.icon) }),
        el('div', { class: 'sc-main' },
          el('div', { class: 'sc-name' }, app.name, app.optional ? el('span', { class: 'badge-pill', style: { marginLeft: '8px' }, text: 'Add-on' }) : null),
          el('div', { class: 'sc-desc', text: app.desc || 'A built-in NyxOS app.' })),
        actions));
    };

    const compat = () => {
      const box = el('div', {});
      box.append(section('Google compatibility (optional)'));
      box.append(el('div', { class: 'list' },
        toggleRow({
          icon: 'shield', iconColor: '#7aa2ff', title: 'Sandboxed Google Play',
          sub: 'Run Play services as an ordinary, permission-restricted app — no special privileges.',
          value: State.get('compat.sandboxedPlay', false),
          onChange: (v) => { State.set('compat.sandboxedPlay', v); sys.toast(v ? 'Sandboxed Play enabled' : 'Sandboxed Play disabled', { icon: 'shield' }); },
        }),
        el('div', { class: 'perm-scope-note' }, 'Provides push, in-app billing, Play Games and FIDO2 for apps that need them — inside the sandbox. ', el('span', { class: 'badge-pill rom', text: 'Represented' })),
      ));
      box.append(el('div', { class: 'list', style: { marginTop: '10px' } },
        el('div', { class: 'store-card' },
          el('div', { class: 'app-icon', style: { background: '#ff9e7a' }, html: icon('download') }),
          el('div', { class: 'sc-main' },
            el('div', { class: 'sc-name' }, 'Aurora-style installs'),
            el('div', { class: 'sc-desc', text: 'Install Play apps anonymously, with no Google account.' })),
          el('span', { class: 'badge-pill rom', text: 'Represented' }))));
      return box;
    };

    function render() {
      const apps = allApps().filter((a) => a.id !== 'store');
      const available = apps.filter((a) => a.optional && !isInstalled(a.id));
      const installed = apps.filter((a) => !a.optional || isInstalled(a.id));
      root.replaceChildren();
      root.append(el('div', { class: 'hint', text: 'De-Googled by default. Free & open source. No account, no tracking.' }));
      if (available.length) { root.append(section('Available add-ons')); available.forEach((a) => root.append(card(a))); }
      root.append(section('On this device'));
      installed.forEach((a) => root.append(card(a)));
      root.append(compat());
    }
    render();
  },
});
