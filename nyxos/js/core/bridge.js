// UI hooks that core modules may call. The shell installs real implementations
// at boot; defaults are safe no-ops so core never hard-depends on the shell.
export const Bridge = {
  toast(_msg, _opts) {},
  banner(_notif) {},               // transient heads-up for a new notification
  openApp(_id) {},
  closeApp() {},
  confirm(_opts) { return Promise.resolve(false); },
  prompt(_opts) { return Promise.resolve(null); },
  requestPermission(_appId, _perm) { return Promise.resolve(false); },
  refreshShade() {},
  reboot() {},
  switchProfile(_id) {},
  install(impl) { Object.assign(Bridge, impl); },
};
