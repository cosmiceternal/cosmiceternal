// Global alarm service. Alarms live in the Clock app's storage scope
// (data.clock.alarms); this OS-level service fires them regardless of whether
// the Clock app is open — including while the screen is locked (AFU).
import { State } from './state.js';
import { Notifications } from './notifications.js';
import { Bridge } from './bridge.js';

export const AlarmService = {
  _timer: null,
  _fired: new Set(),

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this.check(), 15000);
    this.check();
  },
  stop() { clearInterval(this._timer); this._timer = null; },

  check() {
    if (State.dataLocked) return;
    const alarms = State.get('data.clock.alarms', []) || [];
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const minute = `${now.toDateString()} ${hhmm}`;
    for (const a of alarms) {
      if (!a.enabled || a.time !== hhmm) continue;
      const key = `${a.id}@${minute}`;
      if (this._fired.has(key)) continue;
      this._fired.add(key);
      this.ring(a);
    }
    if (this._fired.size > 300) this._fired.clear();
  },

  ring(a) {
    Notifications.post({ appId: 'clock', title: 'Alarm', text: a.label || a.time, icon: 'alarm', color: '#7aa2ff' });
    Bridge.confirm({ title: `⏰ ${a.label || 'Alarm'}`, message: `It’s ${a.time}.`, confirmLabel: 'Dismiss', cancelLabel: 'Snooze 5 min' })
      .then((dismiss) => { if (!dismiss) setTimeout(() => this.ring(a), 5 * 60 * 1000); });
  },
};
