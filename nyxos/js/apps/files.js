import { registerApp } from '../core/registry.js';
import { el, uuid, fmtDateShort } from '../core/util.js';
import { icon } from '../core/icons.js';

const QUOTA = 64 * 1024 * 1024; // simulated 64 MB scope

registerApp({
  id: 'files', name: 'Files', icon: 'files', color: '#6ee7d0', order: 40, dock: true,
  mount(root, sys, ctx) {
    const load = () => {
      let f = sys.storage.get('files', null);
      if (!f) { f = [{ id: uuid(), name: 'welcome.txt', type: 'txt', content: 'Welcome to NyxOS Files.\n\nEverything here lives in this app’s isolated storage scope — no other app can read it, and it is encrypted at rest with your PIN.', ts: Date.now() }]; sys.storage.set('files', f); }
      return f;
    };
    const save = (f) => sys.storage.set('files', f);
    const sizeOf = (file) => (file.content ? new Blob([file.content]).size : 0);

    const showList = () => {
      ctx.clearBack?.();
      ctx.setTitle('Files');
      ctx.setActions([{ icon: 'plus', label: 'New file', onClick: newFile }]);
      const files = load();
      const used = files.reduce((s, f) => s + sizeOf(f), 0);
      const grid = el('div', { class: 'file-grid' });
      for (const f of files) {
        grid.append(el('div', { class: 'file-tile', on: { click: () => showFile(f.id) } },
          el('div', { html: icon(f.type === 'img' ? 'image' : 'doc') }),
          el('div', { class: 'fname', text: f.name })));
      }
      const bar = el('div', {},
        el('div', { class: 'row', style: { borderRadius: '14px', background: 'var(--surface)', border: '1px solid var(--border)' } },
          el('div', { class: 'r-icon', style: { background: '#2a3350' }, html: icon('storage') }),
          el('div', { class: 'r-main' },
            el('div', { class: 'r-title', text: 'Storage scope' }),
            el('div', { class: 'r-sub', text: `${(used / 1024).toFixed(1)} KB of ${(QUOTA / 1024 / 1024)} MB used · isolated to Files` }))),
        el('div', { class: 'storage-bar' }, el('span', { style: { width: Math.min(100, (used / QUOTA) * 100 || 1) + '%' } })));
      root.replaceChildren(bar, el('div', { style: { height: '14px' } }), files.length ? grid : el('div', { class: 'empty-state' }, el('div', { html: icon('files') }), el('p', { text: 'No files' })));
    };

    const newFile = async () => {
      const name = await sys.prompt({ title: 'New text file', placeholder: 'notes.txt', confirmLabel: 'Create' });
      if (!name) return;
      const files = load();
      files.push({ id: uuid(), name: name.endsWith('.txt') ? name : name + '.txt', type: 'txt', content: '', ts: Date.now() });
      save(files); showList();
    };

    const showFile = (id) => {
      const files = load(); const f = files.find((x) => x.id === id);
      if (!f) return showList();
      ctx.setTitle(f.name);
      ctx.pushBack(showList);
      ctx.setActions([
        { icon: 'clipboard', label: 'Copy', onClick: () => { sys.clipboard.write(f.content); sys.toast('Copied', { icon: 'clipboard' }); } },
        { icon: 'trash', label: 'Delete', onClick: async () => { if (await sys.confirm({ title: 'Delete file?', message: f.name, confirmLabel: 'Delete', danger: true })) { save(load().filter((x) => x.id !== id)); showList(); } } },
      ]);
      const area = el('textarea', { class: 'field', value: f.content, style: { minHeight: '50vh' }, attrs: { placeholder: 'Empty file' } });
      let t; area.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { const arr = load(); const cur = arr.find((x) => x.id === id); if (cur) { cur.content = area.value; cur.ts = Date.now(); save(arr); } }, 300); });
      ctx.onCleanup(() => clearTimeout(t));
      root.replaceChildren(el('div', { style: { fontSize: '12px', color: 'var(--text-mute)', marginBottom: '8px' }, text: fmtDateShort(f.ts) }), area);
    };

    showList();
  },
});
