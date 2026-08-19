// Central registry of apps. A near-leaf module both the shell and the permission
// engine import, so an app's metadata (name, declared permissions) is reachable
// without circular dependencies. It also tracks which apps are *installed* on the
// active profile (persisted in the encrypted vault).
import { State } from './state.js';

const _apps = new Map();

export function registerApp(def) {
  if (!def || !def.id) throw new Error('app needs an id');
  _apps.set(def.id, {
    id: def.id,
    name: def.name || def.id,
    color: def.color || '#6ee7d0',
    icon: def.icon || 'info',
    system: !!def.system,          // system apps can't be uninstalled
    optional: !!def.optional,      // not installed by default (offered in the store)
    desc: def.desc || '',
    perms: def.perms || [],        // extra declared permissions beyond the implicit set
    chrome: def.chrome,
    widget: def.widget || null,
    mount: def.mount,
    unmount: def.unmount || null,
    dock: !!def.dock,
    order: def.order ?? 100,
  });
}

export const getApp = (id) => _apps.get(id);
export const allApps = () => [..._apps.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
export const appName = (id) => _apps.get(id)?.name || id;

/** Seed the installed set for a freshly unlocked profile if absent. */
export function ensureInstalled() {
  if (State.locked) return;
  if (State.get('apps.installed', null) == null) {
    State.set('apps.installed', allApps().filter((a) => !a.optional && !a.system).map((a) => a.id), { silent: true });
  }
}

export function isInstalled(id) {
  const a = getApp(id);
  if (!a) return false;
  if (a.system) return true;
  const inst = State.get('apps.installed', null);
  return inst == null ? !a.optional : inst.includes(id);
}

export function installedApps() { return allApps().filter((a) => isInstalled(a.id)); }

export function setInstalled(id, on) {
  const a = getApp(id);
  if (!a || a.system) return;
  let inst = State.get('apps.installed', null);
  if (inst == null) inst = allApps().filter((x) => !x.optional && !x.system).map((x) => x.id);
  inst = inst.filter((x) => x !== id);
  if (on) inst.push(id);
  State.set('apps.installed', inst);
}
