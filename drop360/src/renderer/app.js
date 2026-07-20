const api = window.drop360;

const els = {
  library: document.getElementById('library'),
  dropHero: document.getElementById('drop-hero'),
  dropOverlay: document.getElementById('drop-overlay'),
  corePill: document.getElementById('core-pill'),
  corePillText: document.getElementById('core-pill-text'),
  coreProgress: document.getElementById('core-progress'),
  coreProgressBar: document.getElementById('core-progress-bar'),
  coreInstallBtn: document.getElementById('core-install-btn'),
  addGamesBtn: document.getElementById('add-games-btn'),
  browseBtn: document.getElementById('browse-btn'),
  settingsBtn: document.getElementById('settings-btn'),
  settingsDialog: document.getElementById('settings-dialog'),
  settingsCloseBtn: document.getElementById('settings-close-btn'),
  redownloadBtn: document.getElementById('redownload-btn'),
  locateBtn: document.getElementById('locate-btn'),
  fullscreenCheck: document.getElementById('fullscreen-check'),
  corePath: document.getElementById('core-path'),
  toasts: document.getElementById('toasts'),
};

const state = {
  games: [],
  core: { installed: false, path: null, platform: 'win32' },
  settings: { variant: 'canary', fullscreen: false },
  installing: false,
};

/* ---------- helpers ---------- */

function toast(message, kind = 'info', ms = 4500) {
  const node = document.createElement('div');
  node.className = `toast${kind === 'error' ? ' error' : ''}`;
  node.textContent = message;
  els.toasts.appendChild(node);
  setTimeout(() => node.remove(), ms);
}

function formatSize(bytes) {
  if (!bytes) return '';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function formatLastPlayed(iso) {
  if (!iso) return 'Never played';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days === 0) return 'Played today';
  if (days === 1) return 'Played yesterday';
  return `Played ${days} days ago`;
}

function tileGradient(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  const hue = hash % 360;
  return `linear-gradient(135deg, hsl(${hue}, 45%, 26%), hsl(${(hue + 40) % 360}, 55%, 16%))`;
}

function tileInitials(name) {
  const words = name.split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

/* ---------- rendering ---------- */

function renderCorePill() {
  els.corePill.classList.remove('ready', 'error');
  if (state.installing) {
    els.coreInstallBtn.hidden = true;
    return;
  }
  els.coreProgress.hidden = true;
  if (state.core.installed) {
    els.corePill.classList.add('ready');
    els.corePillText.textContent = '● Xenia core ready';
    els.coreInstallBtn.hidden = true;
  } else {
    els.corePillText.textContent = 'Emulator core not installed';
    els.coreInstallBtn.hidden = false;
  }
}

function renderLibrary() {
  els.library.replaceChildren();
  els.dropHero.hidden = state.games.length > 0;

  for (const game of state.games) {
    const card = document.createElement('div');
    card.className = 'game-card';

    const tile = document.createElement('div');
    tile.className = 'game-tile';
    tile.style.background = tileGradient(game.name);
    tile.textContent = tileInitials(game.name);

    const body = document.createElement('div');
    body.className = 'game-body';

    const name = document.createElement('div');
    name.className = 'game-name';
    name.textContent = game.name;
    name.title = game.path;

    const meta = document.createElement('div');
    meta.className = 'game-meta';
    meta.textContent = [formatSize(game.sizeBytes), formatLastPlayed(game.lastPlayedAt)]
      .filter(Boolean)
      .join(' · ');

    const actions = document.createElement('div');
    actions.className = 'game-actions';

    const playBtn = document.createElement('button');
    playBtn.className = 'btn btn-accent play';
    playBtn.textContent = '▶ Play';
    playBtn.addEventListener('click', () => launchGame(game));

    const folderBtn = document.createElement('button');
    folderBtn.className = 'btn btn-icon';
    folderBtn.title = 'Show in folder';
    folderBtn.textContent = '📁';
    folderBtn.addEventListener('click', () => api.showInFolder(game.id));

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-icon btn-danger';
    removeBtn.title = 'Remove from library (does not delete the file)';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', async () => {
      const result = await api.removeGame(game.id);
      state.games = result.games;
      renderLibrary();
      toast(`Removed "${game.name}" from your library. The file itself was not deleted.`);
    });

    actions.append(playBtn, folderBtn, removeBtn);
    body.append(name, meta, actions);
    card.append(tile, body);
    els.library.appendChild(card);
  }
}

/* ---------- actions ---------- */

async function launchGame(game) {
  const result = await api.launchGame(game.id);
  if (!result.ok) {
    toast(result.error, 'error', 7000);
    return;
  }
  state.games = (await api.getLibrary()).games;
  renderLibrary();
  toast(`Launching "${game.name}" — the first boot can take a little while.`);
}

async function addGames(paths) {
  if (!paths.length) return;
  const result = await api.addGames(paths);
  state.games = result.games;
  renderLibrary();
  if (result.added.length) {
    const names = result.added.map((g) => `"${g.name}"`).join(', ');
    toast(`Added ${names} to your library.`);
  }
  for (const rejection of result.rejected) {
    toast(`Skipped ${rejection.path}\n${rejection.reason}`, 'error', 6500);
  }
}

async function installCore() {
  if (state.installing) return;
  state.installing = true;
  els.coreInstallBtn.hidden = true;
  els.corePillText.textContent = 'Starting download…';
  els.coreProgress.hidden = false;
  els.coreProgressBar.style.width = '0%';

  const result = await api.downloadCore(state.settings.variant);
  state.installing = false;
  if (result.ok && result.installed) {
    state.core = result;
    toast('Xenia core installed — you are ready to play.');
  } else {
    toast(`Could not install the emulator core: ${result.error || 'unknown error'}`, 'error', 8000);
  }
  renderCorePill();
  renderSettings();
}

/* ---------- settings ---------- */

function renderSettings() {
  for (const radio of els.settingsDialog.querySelectorAll('input[name="variant"]')) {
    radio.checked = radio.value === state.settings.variant;
  }
  els.fullscreenCheck.checked = Boolean(state.settings.fullscreen);
  els.corePath.textContent = state.core.installed ? `Core: ${state.core.path}` : 'Core: not installed';
}

function wireSettings() {
  els.settingsBtn.addEventListener('click', () => {
    renderSettings();
    els.settingsDialog.showModal();
  });
  els.settingsCloseBtn.addEventListener('click', () => els.settingsDialog.close());

  for (const radio of els.settingsDialog.querySelectorAll('input[name="variant"]')) {
    radio.addEventListener('change', async () => {
      const result = await api.setSettings({ variant: radio.value });
      state.settings = result.settings;
    });
  }

  els.fullscreenCheck.addEventListener('change', async () => {
    const result = await api.setSettings({ fullscreen: els.fullscreenCheck.checked });
    state.settings = result.settings;
  });

  els.redownloadBtn.addEventListener('click', () => {
    els.settingsDialog.close();
    installCore();
  });

  els.locateBtn.addEventListener('click', async () => {
    state.core = await api.locateCore();
    renderCorePill();
    renderSettings();
    if (state.core.installed) toast('Emulator core location saved.');
  });
}

/* ---------- drag & drop ---------- */

function wireDragAndDrop() {
  let dragDepth = 0;

  window.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth += 1;
    els.dropOverlay.hidden = false;
  });

  window.addEventListener('dragover', (event) => event.preventDefault());

  window.addEventListener('dragleave', (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) els.dropOverlay.hidden = true;
  });

  window.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    els.dropOverlay.hidden = true;
    const paths = [...event.dataTransfer.files].map((file) => api.pathForFile(file)).filter(Boolean);
    if (paths.length) addGames(paths);
  });
}

/* ---------- init ---------- */

async function browse() {
  const result = await api.browseForGames();
  await addGames(result.paths);
}

async function init() {
  els.addGamesBtn.addEventListener('click', browse);
  els.browseBtn.addEventListener('click', browse);
  els.coreInstallBtn.addEventListener('click', installCore);
  wireSettings();
  wireDragAndDrop();

  api.onCoreProgress((progress) => {
    if (progress.phase === 'downloading') {
      const pct = progress.total ? Math.floor((progress.received / progress.total) * 100) : 0;
      els.corePillText.textContent = progress.total
        ? `Downloading Xenia core… ${pct}%`
        : 'Downloading Xenia core…';
      els.coreProgressBar.style.width = `${pct}%`;
    } else if (progress.phase === 'extracting') {
      els.corePillText.textContent = 'Unpacking core…';
      els.coreProgressBar.style.width = '100%';
    }
  });

  api.onLaunchError((payload) => toast(payload.error, 'error', 8000));

  const [library, core, settings] = await Promise.all([
    api.getLibrary(),
    api.getCoreStatus(),
    api.getSettings(),
  ]);
  state.games = library.games;
  state.core = core;
  state.settings = settings.settings;

  renderLibrary();
  renderCorePill();

  if (!state.core.installed) {
    toast('Welcome! First step: click "Install emulator core" — Drop360 will fetch the Xenia Xbox 360 core for you.', 'info', 8000);
  }
}

init();
