import { registerApp } from '../core/registry.js';
import { el } from '../core/util.js';
import { icon } from '../core/icons.js';
import { State } from '../core/state.js';
import { bigButton } from '../shell/kit.js';

registerApp({
  id: 'camera', name: 'Camera', icon: 'camera', color: '#ff9e7a', order: 70, dock: true, perms: ['camera', 'microphone'],
  mount(root, sys, ctx) {
    let stream = null;
    const load = () => sys.storage.get('photos', []);
    const save = (p) => sys.storage.set('photos', p);
    ctx.setTitle('Camera');

    const stop = () => { if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; } };
    ctx.onCleanup(stop);

    const showGallery = () => {
      ctx.pushBack(render);
      ctx.setTitle('Gallery');
      const photos = load();
      if (!photos.length) { root.replaceChildren(el('div', { class: 'empty-state' }, el('div', { html: icon('image') }), el('p', { text: 'No photos' }))); return; }
      const grid = el('div', { class: 'file-grid' });
      for (const p of photos) grid.append(el('img', { src: p.data, style: { width: '100%', borderRadius: '12px', aspectRatio: '1', objectFit: 'cover' } }));
      root.replaceChildren(grid);
    };

    const savePhoto = (dataUrl) => { const p = load(); p.unshift({ id: Date.now(), data: dataUrl, ts: Date.now() }); if (p.length > 30) p.length = 30; save(p); sys.toast('Photo saved', { type: 'ok', icon: 'check' }); };

    const simulateShot = () => {
      const c = document.createElement('canvas'); c.width = 400; c.height = 400;
      const g = c.getContext('2d');
      const grd = g.createLinearGradient(0, 0, 400, 400);
      grd.addColorStop(0, `hsl(${Math.random() * 360},60%,55%)`); grd.addColorStop(1, `hsl(${Math.random() * 360},60%,35%)`);
      g.fillStyle = grd; g.fillRect(0, 0, 400, 400);
      g.fillStyle = 'rgba(255,255,255,.85)'; g.font = '20px system-ui'; g.fillText('NyxOS · ' + new Date().toLocaleTimeString(), 20, 380);
      savePhoto(c.toDataURL('image/png'));
    };

    async function render() {
      ctx.clearBack?.();
      ctx.setTitle('Camera');
      ctx.setActions([{ icon: 'image', label: 'Gallery', onClick: showGallery }]);
      stop();

      if (!sys.perms.has('camera')) {
        root.replaceChildren(el('div', { class: 'empty-state' },
          el('div', { html: icon('camera') }), el('h3', { text: 'Camera permission needed' }),
          el('p', { class: 'hint', text: 'NyxOS blocks camera access until you allow it for this app.' }),
          el('div', { style: { marginTop: '14px' } }, bigButton('Allow camera', { kind: 'primary', icon: 'camera', onClick: async () => { if (await sys.perms.request('camera')) render(); } }))));
        return;
      }

      const video = el('video', { attrs: { autoplay: '', playsinline: '', muted: '' }, style: { width: '100%', borderRadius: '18px', background: '#000', aspectRatio: '3/4', objectFit: 'cover' } });
      video.muted = true;
      const shoot = bigButton('Capture', { kind: 'primary', icon: 'camera', onClick: () => {
        if (stream) { const c = document.createElement('canvas'); c.width = video.videoWidth || 400; c.height = video.videoHeight || 400; c.getContext('2d').drawImage(video, 0, 0, c.width, c.height); savePhoto(c.toDataURL('image/png')); }
        else simulateShot();
      } });
      root.replaceChildren(video, el('div', { style: { marginTop: '14px' } }, shoot));

      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
        video.srcObject = stream;
      } catch {
        root.replaceChildren(el('div', { class: 'empty-state' },
          el('div', { html: icon('camera') }), el('h3', { text: 'No camera available' }),
          el('p', { class: 'hint', text: 'Permission is granted, but this device has no usable camera here. You can still capture a sample image to test the gallery.' }),
          el('div', { style: { marginTop: '14px' } }, bigButton('Capture sample', { kind: 'primary', icon: 'camera', onClick: simulateShot }),
            el('div', { style: { height: '8px' } }), bigButton('Open gallery', { onClick: showGallery }))));
      }
    }
    render();
  },
});
