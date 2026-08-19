import { el } from '../core/util.js';
import { icon } from '../core/icons.js';

export const Navbar = {
  host: null,
  mount(host, { onBack, onHome, onRecents }) {
    this.host = host;
    host.replaceChildren(
      el('button', { class: 'nav-back', attrs: { 'aria-label': 'Back' }, html: icon('back'), on: { click: onBack } }),
      el('button', { class: 'nav-home', attrs: { 'aria-label': 'Home' }, html: icon('home'), on: { click: onHome } }),
      el('button', { class: 'nav-recents', attrs: { 'aria-label': 'Recent apps' }, html: icon('recents'), on: { click: onRecents } }),
    );
  },
  setHidden(hidden) { this.host?.classList.toggle('hidden', hidden); },
};
