// The shell: owns #stage transitions (lock / home / app), the overlays
// (drawer, shade, recents, modals), the status + nav bars, and installs the
// Bridge hooks core modules call.
import { el } from '../core/util.js';
import { icon } from '../core/icons.js';
import { State } from '../core/state.js';
import { Bridge } from '../core/bridge.js';
import { LockPolicy, duressWipe } from '../core/security.js';
import { Notifications } from '../core/notifications.js';
import { AlarmService } from '../core/alarms.js';
import { ensureInstalled } from '../core/registry.js';
import { applyTheme } from './theme-apply.js';
import { Statusbar } from './statusbar.js';
import { Navbar } from './navbar.js';
import { Shade } from './shade.js';
import { buildLock, buildSetup } from './lockscreen.js';
import { buildHome } from './home.js';
import { buildDrawer } from './drawer.js';
import { buildRecents } from './recents.js';
import { mountApp } from './appframe.js';
import { toast, confirm, modal, installUIBridge } from './ui.js';

export const Shell = {
  stage: null, screen: null,
  homeLayer: null, drawerLayer: null, recentsLayer: null, lockOverlay: null,
  currentApp: null, recents: [],

  init() {
    this.screen = document.getElementById('screen');
    this.stage = document.getElementById('stage');
    const oldShade = document.getElementById('shade');
    if (oldShade) oldShade.remove();

    Statusbar.mount(document.getElementById('statusbar'));
    Navbar.mount(document.getElementById('navbar'), {
      onBack: () => this.back(),
      onHome: () => this.goHome(),
      onRecents: () => this.openRecents(),
    });

    installUIBridge();
    Bridge.install({
      banner: (n) => this.banner(n),
      openApp: (id, arg) => this.openApp(id, arg),
      closeApp: () => this.closeApp(),
      refreshShade: () => Shade.refresh(),
      reboot: () => this.reboot(),
      switchProfile: (id) => this.switchProfile(id),
    });

    // Shade lives above the stage.
    this.screen.appendChild(Shade.build({ onOpenSettings: () => this.openApp('settings'), onLock: () => this.screenLock() }));

    // Top "grabber": tap or swipe down to reveal the notification shade.
    const grabber = el('div', { style: { position: 'absolute', top: '0', left: '0', right: '0', height: '36px', zIndex: '40' } });
    let gy = null;
    grabber.addEventListener('click', () => { if (!State.locked) Shade.toggle(); });
    grabber.addEventListener('touchstart', (e) => { gy = e.touches[0].clientY; }, { passive: true });
    grabber.addEventListener('touchend', (e) => { if (gy != null && !State.locked && e.changedTouches[0].clientY - gy > 30) Shade.open(); gy = null; });
    this.screen.appendChild(grabber);

    // Auto-lock on inactivity; any interaction resets the timer.
    ['pointerdown', 'keydown'].forEach((ev) =>
      document.addEventListener(ev, () => LockPolicy.reset(), { passive: true }));

    State.events.on('change', (path) => {
      if (path && String(path).startsWith('settings')) applyTheme();
      if (path === 'security.autoLockMs') LockPolicy.reset();
    });
  },

  // --- entry ----------------------------------------------------------
  decideEntry() {
    Navbar.setHidden(true);
    if (State.device.profiles.length === 0) this.showSetup();
    else this.showLock(State.device.activeId || State.device.profiles[0].id);
  },

  showSetup() {
    Navbar.setHidden(true);
    this._setBase(buildSetup({ onComplete: (id, key, vault) => this.onUnlocked(id, key, vault) }));
  },

  showLock(profileId) {
    Navbar.setHidden(true);
    this._removeOverlay();
    this.teardownApp();
    Shade.close();
    const layer = buildLock({
      profileId,
      onUnlock: (key, vault) => this.onUnlocked(profileId, key, vault),
      onDuress: () => this.onDuress(),
    });
    if (State.device.profiles.length > 1) {
      const cur = State.device.profiles.find((p) => p.id === profileId);
      layer.append(el('button', {
        class: 'btn btn-ghost', style: { margin: '10px auto 0' },
        html: icon('users') + `<span style="margin-left:6px">${cur ? cur.name : 'Profile'} · switch</span>`,
        on: { click: () => this.pickProfile() },
      }));
    }
    this._setBase(layer);
    applyTheme();
  },

  async pickProfile() {
    const body = el('div', {});
    State.device.profiles.forEach((p) => {
      body.append(el('button', {
        class: 'row tap', style: { width: '100%', borderRadius: '12px', marginBottom: '6px', background: 'var(--surface-2)' },
        html: `<span class="r-icon" style="background:${p.color}">${icon('user')}</span><span class="r-main"><span class="r-title">${p.name}</span></span>`,
        on: { click: () => { document.querySelector('.modal-scrim')?.remove(); this.showLock(p.id); } },
      }));
    });
    modal({ title: 'Unlock profile', body, actions: [{ label: 'Close', kind: 'ghost', value: null }] });
  },

  onUnlocked(id, key, vault) {
    State.unlock(id, key, vault);
    ensureInstalled();
    this.seedDemoNotifications();
    this.recents = [];
    this.goToHome();
    AlarmService.start();
  },

  goToHome() {
    applyTheme();
    LockPolicy.arm(() => this.screenLock());
    this.buildHomeAndDrawer();
    this._setBase(this.homeLayer);
    Navbar.setHidden(false);
    Statusbar.refresh();
  },

  // Screen lock (AFU): frosted overlay on top of the live UI; keys stay in
  // memory so the lock screen can show notifications and unlock is instant.
  screenLock() {
    if (State.dataLocked) return;
    State.screenLock();
    LockPolicy.disarm();
    Shade.close(); this.closeDrawer(); this.closeRecents();
    Navbar.setHidden(true);
    const layer = buildLock({
      profileId: State.activeId,
      showNotifs: true,
      onUnlock: () => this.resumeFromLock(),
      onDuress: () => this.onDuress(),
    });
    layer.classList.add('lock-overlay');
    this._removeOverlay();
    this.lockOverlay = layer;
    this.screen.appendChild(layer);
    Statusbar.refresh();
  },

  resumeFromLock() {
    State.unlockScreen();
    this._removeOverlay();
    applyTheme();
    LockPolicy.arm(() => this.screenLock());
    Navbar.setHidden(false);
    Statusbar.refresh();
  },

  _removeOverlay() {
    if (this.lockOverlay) { try { this.lockOverlay._cleanup?.(); } catch {} this.lockOverlay.remove(); this.lockOverlay = null; }
  },

  seedDemoNotifications() {
    if (State.get('seededDemo', false)) return;
    State.set('seededDemo', true, { silent: true });
    Notifications.post({ appId: 'system', title: 'Welcome to NyxOS', text: 'Your profile is encrypted. Swipe down for quick settings, up for all apps.', icon: 'moon', color: '#6ee7d0' });
    Notifications.post({ appId: 'messages', title: 'Alex', text: 'Hey — are we still on for tonight?', icon: 'chat', color: '#7aa2ff', sensitive: true });
  },

  onDuress() {
    AlarmService.stop();
    duressWipe();
    // Wipe complete — reinitialize to a pristine device and show setup.
    State.init();
    toast('Data wiped', { type: 'danger', icon: 'shield' });
    this.recents = [];
    this._removeOverlay();
    this.teardownApp();
    this.decideEntry();
  },

  lock() {
    if (State.locked) return;
    const id = State.activeId;
    State.lock();
    LockPolicy.disarm();
    this.showLock(id);
  },

  switchProfile(id) {
    if (!State.locked) { State.lock(); LockPolicy.disarm(); }
    this.teardownApp();
    this.showLock(id);
  },

  // --- home + drawer --------------------------------------------------
  buildHomeAndDrawer() {
    this.drawerLayer?.remove();
    this.homeLayer = buildHome({
      onOpenApp: (id) => this.openApp(id),
      onOpenDrawer: () => this.openDrawer(),
      onOpenAppInfo: (id) => this.openApp('privacy', id),
    });
    this.drawerLayer = buildDrawer({
      onOpenApp: (id) => { this.closeDrawer(); this.openApp(id); },
      onOpenAppInfo: (id) => { this.closeDrawer(); this.openApp('privacy', id); },
    });
    this.stage.appendChild(this.drawerLayer);
  },

  openDrawer() { this.drawerLayer?._reset?.(); this.drawerLayer?.classList.add('open'); },
  closeDrawer() { this.drawerLayer?.classList.remove('open'); },
  drawerOpen() { return !!this.drawerLayer?.classList.contains('open'); },

  goHome() {
    Shade.close();
    this.closeDrawer();
    this.closeRecents();
    this.closeApp();
  },

  // --- apps -----------------------------------------------------------
  openApp(id, arg) {
    if (State.locked) return;
    Shade.close(); this.closeDrawer(); this.closeRecents();
    this.teardownApp();
    const mounted = mountApp(id, { onClose: () => this.closeApp(), arg });
    if (!mounted) { toast('App not found', { icon: 'alert' }); return; }
    this.currentApp = { id, ...mounted };
    this.stage.appendChild(mounted.layer);
    this.recents = [id, ...this.recents.filter((x) => x !== id)].slice(0, 8);
    Navbar.setHidden(false);
    LockPolicy.reset();
  },

  teardownApp() {
    if (this.currentApp) {
      try { this.currentApp.layer._cleanup?.(); } catch {}
      this.currentApp.layer.remove();
      this.currentApp = null;
    }
  },

  closeApp() { this.teardownApp(); /* home base remains underneath */ },

  back() {
    if (Shade.isOpen()) return Shade.close();
    if (this.recentsLayer) return this.closeRecents();
    if (this.drawerOpen()) return this.closeDrawer();
    if (this.currentApp) { if (this.currentApp.handleBack()) return; return this.closeApp(); }
  },

  // --- recents --------------------------------------------------------
  openRecents() {
    if (State.locked) return;
    Shade.close(); this.closeDrawer(); this.closeRecents();
    this.recentsLayer = buildRecents({
      recents: this.recents,
      onOpen: (id) => { this.closeRecents(); this.openApp(id); },
      onClear: () => { this.recents = []; this.closeRecents(); },
    });
    this.stage.appendChild(this.recentsLayer);
  },
  closeRecents() { this.recentsLayer?.remove(); this.recentsLayer = null; },

  // --- notifications heads-up ----------------------------------------
  banner(n) {
    if (State.get('toggles.dnd', false)) return;
    if (State.locked) return;
    toast(n.title, { icon: n.icon || 'bell' });
  },

  // --- base layer swap ------------------------------------------------
  _setBase(layer) {
    // Remove any existing base (lock/home/setup) but keep persistent overlays.
    [...this.stage.children].forEach((c) => {
      if (c === this.drawerLayer) return;
      if (this.recentsLayer && c === this.recentsLayer) return;
      if (this.currentApp && c === this.currentApp.layer) return;
      if (c.classList.contains('screen-layer')) { c._cleanup?.(); c.remove(); }
    });
    this.base = layer;
    this.stage.insertBefore(layer, this.stage.firstChild);
  },

  reboot() {
    State.lock?.();
    this.teardownApp();
    this.closeRecents();
    location.reload();
  },
};
