import { registerApp } from '../core/registry.js';
import { el, uuid, fmtDateShort } from '../core/util.js';
import { icon } from '../core/icons.js';
import { list, row } from '../shell/kit.js';

registerApp({
  id: 'notes', name: 'Notes', icon: 'notes', color: '#ffd166', order: 30, dock: true,
  mount(root, sys, ctx) {
    const load = () => sys.storage.get('notes', []);
    const save = (notes) => sys.storage.set('notes', notes);

    const showList = () => {
      ctx.clearBack?.();
      ctx.setTitle('Notes');
      ctx.setActions([{ icon: 'plus', label: 'New note', onClick: () => newNote() }]);
      root.replaceChildren();
      const notes = load().sort((a, b) => b.ts - a.ts);
      if (!notes.length) {
        root.append(el('div', { class: 'empty-state' }, el('div', { html: icon('notes') }), el('p', { text: 'No notes yet' }), el('p', { class: 'hint', text: 'Tap + to write one. Notes are stored encrypted in this profile only.' })));
        return;
      }
      root.append(list(...notes.map((n) => row({
        title: n.title || 'Untitled',
        sub: (n.body || '').slice(0, 60) || fmtDateShort(n.ts),
        onClick: () => showEditor(n.id),
      }))));
    };

    const newNote = () => { const n = { id: uuid(), title: '', body: '', ts: Date.now() }; const notes = load(); notes.push(n); save(notes); showEditor(n.id); };

    const showEditor = (id) => {
      const notes = load();
      const n = notes.find((x) => x.id === id);
      if (!n) return showList();
      ctx.setTitle('');
      ctx.setActions([
        { icon: 'clipboard', label: 'Copy', onClick: () => { sys.clipboard.write(`${n.title}\n${n.body}`); sys.toast('Copied to clipboard', { icon: 'clipboard' }); } },
        { icon: 'trash', label: 'Delete', onClick: async () => { if (await sys.confirm({ title: 'Delete note?', message: 'This cannot be undone.', confirmLabel: 'Delete', danger: true })) { save(load().filter((x) => x.id !== id)); showList(); } } },
      ]);
      ctx.pushBack(() => showList());

      const titleInput = el('input', { class: 'note-title-input', attrs: { placeholder: 'Title' }, value: n.title });
      const bodyInput = el('textarea', { class: 'field', attrs: { placeholder: 'Start writing…' }, value: n.body, style: { minHeight: '50vh' } });
      let t;
      const persist = () => {
        clearTimeout(t);
        t = setTimeout(() => {
          const arr = load(); const cur = arr.find((x) => x.id === id);
          if (cur) { cur.title = titleInput.value; cur.body = bodyInput.value; cur.ts = Date.now(); save(arr); }
        }, 300);
      };
      titleInput.addEventListener('input', persist);
      bodyInput.addEventListener('input', persist);
      ctx.onCleanup(() => { clearTimeout(t); const arr = load(); const cur = arr.find((x) => x.id === id); if (cur) { cur.title = titleInput.value; cur.body = bodyInput.value; save(arr); } });

      root.replaceChildren(el('div', { class: 'note-editor' }, titleInput, bodyInput));
    };

    showList();
  },
});
