// Notification center. Notifications live in the encrypted vault, so they persist
// per profile and are wiped with it. Sensitive ones are content-hidden on the
// lockscreen when the corresponding security setting is on.
import { State } from './state.js';
import { Bridge } from './bridge.js';
import { uuid } from './util.js';

const MAX = 60;

export const Notifications = {
  list() { return State.get('notifications', []) || []; },
  unreadCount() { return this.list().filter((n) => !n.read).length; },
  countForApp(appId) { return this.list().filter((n) => n.appId === appId && !n.read).length; },

  post({ appId = 'system', title, text = '', sensitive = false, icon = null, color = null }) {
    const notif = { id: uuid(), appId, title, text, sensitive, icon, color, ts: Date.now(), read: false };
    const list = this.list();
    list.unshift(notif);
    if (list.length > MAX) list.length = MAX;
    State.set('notifications', list, { silent: true });
    State.events.emit('notif', notif);
    Bridge.banner(notif);
    Bridge.refreshShade();
    return notif.id;
  },

  dismiss(id) {
    State.set('notifications', this.list().filter((n) => n.id !== id), { silent: true });
    State.events.emit('notif-change');
    Bridge.refreshShade();
  },

  markAllRead() {
    State.set('notifications', this.list().map((n) => ({ ...n, read: true })), { silent: true });
    State.events.emit('notif-change');
  },

  clear() {
    State.set('notifications', [], { silent: true });
    State.events.emit('notif-change');
    Bridge.refreshShade();
  },
};
