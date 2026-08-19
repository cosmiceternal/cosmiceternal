import { registerApp } from '../core/registry.js';
import { el } from '../core/util.js';
import { icon } from '../core/icons.js';
import { State } from '../core/state.js';
import { installedApps, getApp } from '../core/registry.js';
import { permsForApp, getPerm, setPerm, PERMISSIONS } from '../core/permissions.js';
import { section, list, row, toggle, toggleRow } from '../shell/kit.js';

registerApp({
  id: 'privacy', name: 'Privacy', icon: 'shield', color: '#6ee7d0', order: 5, system: true,
  mount(root, sys, ctx) {
    const showList = () => {
      ctx.clearBack?.();
      ctx.setTitle('Privacy');
      ctx.setActions([]);
      const sec = () => State.get('security', {}) || {};

      const controls = list(
        toggleRow({ icon: 'clipboard', iconColor: '#ffd166', title: 'Clipboard access alerts', sub: 'Notify when an app reads the clipboard', value: sec().clipboardNotify, onChange: (v) => State.set('security.clipboardNotify', v) }),
        toggleRow({ icon: 'eyeOff', iconColor: '#7aa2ff', title: 'Hide sensitive notifications', sub: 'Blur private content on the lock screen', value: sec().hideNotifContent, onChange: (v) => State.set('security.hideNotifContent', v) }),
        toggleRow({ icon: 'lock', iconColor: '#c58cff', title: 'Mask password entry', sub: 'Hide characters while typing passwords', value: sec().hidePasswords, onChange: (v) => State.set('security.hidePasswords', v) }),
        toggleRow({ icon: 'edit', iconColor: '#8be9a0', title: 'Keyboard suggestions', sub: 'Personalized suggestions (off by default)', value: sec().keyboardSuggestions, onChange: (v) => State.set('security.keyboardSuggestions', v) }),
        toggleRow({ icon: 'sensor', iconColor: '#ff9e7a', title: 'Sensors', sub: 'Master switch for motion & orientation sensors', value: sec().sensorsGlobal !== false, onChange: (v) => State.set('security.sensorsGlobal', v) }),
      );

      const apps = installedApps();
      const appRows = apps.map((a) => {
        const perms = permsForApp(a.id).filter((p) => getPerm(a.id, p));
        return row({ icon: a.icon, iconColor: a.color, title: a.name, sub: `${perms.length} permission${perms.length === 1 ? '' : 's'} granted`, onClick: () => showApp(a.id) });
      });

      root.replaceChildren(
        section('Privacy controls'), controls,
        section('App permissions'), list(...appRows),
        el('div', { class: 'hint', text: 'Storage Scopes are always enforced: every app can only read its own data.' }),
      );
    };

    const showApp = (appId) => {
      const app = getApp(appId);
      if (!app) return showList();
      ctx.setTitle('App info');
      ctx.pushBack(showList);

      const head = el('div', { class: 'perm-app-head' },
        el('div', { class: 'app-icon', style: { background: app.color }, html: icon(app.icon) }),
        el('div', {}, el('div', { class: 'pa-name', text: app.name }), el('div', { class: 'pa-sub', text: app.system ? 'System app' : (app.optional ? 'Add-on' : 'Installed app') })));

      const rows = permsForApp(appId).map((p) => {
        const meta = PERMISSIONS[p];
        const locked = meta.locked;
        const t = toggle(locked ? true : getPerm(appId, p), (v) => setPerm(appId, p, v));
        if (locked) { t.style.opacity = '.55'; t.style.pointerEvents = 'none'; }
        const r = row({ icon: meta.icon, iconColor: '#2a3350', title: meta.name, sub: meta.desc, right: t });
        return r;
      });

      const notes = el('div', {});
      if (getPerm(appId, 'network')) {
        const wifi = State.get('toggles.wifi', true), air = State.get('toggles.airplane', false);
        if (air || !wifi) notes.append(el('div', { class: 'hint warn', text: 'Network is granted but currently blocked by ' + (air ? 'Airplane mode' : 'Wi‑Fi being off') + '.' }));
      }

      root.replaceChildren(head, list(...rows),
        el('div', { class: 'perm-scope-note' }, 'Storage Scopes keep this app’s files isolated and encrypted — this cannot be turned off.'),
        notes);
    };

    if (ctx.arg && getApp(ctx.arg)) showApp(ctx.arg);
    else showList();
  },
});
