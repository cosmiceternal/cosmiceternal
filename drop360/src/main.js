const { app, BrowserWindow, ipcMain, dialog, shell, net } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const extract = require('extract-zip');

// Xenia also boots STFS/GoD containers, which usually have no extension at all;
// those are accepted separately in resolveGame().
const GAME_EXTENSIONS = new Set(['.iso', '.xex', '.xexp', '.zar', '.elf']);

const CORE_VARIANTS = {
  canary: {
    label: 'Xenia Canary (recommended)',
    url: 'https://github.com/xenia-canary/xenia-canary-releases/releases/latest/download/xenia_canary_windows.zip',
  },
  stable: {
    label: 'Xenia master',
    url: 'https://github.com/xenia-project/release-builds-windows/releases/latest/download/xenia_master.zip',
  },
};

let win = null;

const libraryFile = () => path.join(app.getPath('userData'), 'library.json');
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const coreDir = () => path.join(app.getPath('userData'), 'xenia');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

const loadLibrary = () => readJson(libraryFile(), []);
const saveLibrary = (games) => writeJson(libraryFile(), games);

function loadSettings() {
  return { variant: 'canary', fullscreen: false, customCorePath: null, ...readJson(settingsFile(), {}) };
}
const saveSettings = (settings) => writeJson(settingsFile(), settings);

function findCoreExe() {
  const settings = loadSettings();
  if (settings.customCorePath && fs.existsSync(settings.customCorePath)) {
    return settings.customCorePath;
  }
  const root = coreDir();
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (/^xenia.*\.exe$/i.test(entry.name)) return full;
    }
  }
  return null;
}

function coreStatus() {
  const exe = findCoreExe();
  return {
    ok: true,
    installed: Boolean(exe),
    path: exe,
    platform: process.platform,
    variants: Object.fromEntries(Object.entries(CORE_VARIANTS).map(([key, v]) => [key, v.label])),
  };
}

let lastProgressAt = 0;
function sendProgress(progress) {
  const now = Date.now();
  if (progress.phase !== 'downloading' || now - lastProgressAt > 100) {
    lastProgressAt = now;
    if (win && !win.isDestroyed()) win.webContents.send('core:progress', progress);
  }
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const request = net.request(url);
    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        response.on('data', () => {});
        response.on('error', () => {});
        reject(new Error(`Download failed (HTTP ${response.statusCode})`));
        return;
      }
      const rawLength = response.headers['content-length'];
      const total = Number(Array.isArray(rawLength) ? rawLength[0] : rawLength) || 0;
      let received = 0;
      const out = fs.createWriteStream(dest);
      response.on('data', (chunk) => {
        received += chunk.length;
        out.write(chunk);
        sendProgress({ phase: 'downloading', received, total });
      });
      response.on('end', () => out.end(resolve));
      response.on('error', reject);
      out.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

function prettifyName(name) {
  return name.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim() || name;
}

async function resolveGame(rawPath) {
  const stat = await fsp.stat(rawPath);
  if (stat.isDirectory()) {
    // An extracted game folder boots from the default.xex inside it.
    const candidate = path.join(rawPath, 'default.xex');
    if (!fs.existsSync(candidate)) return null;
    return { path: candidate, name: prettifyName(path.basename(rawPath)) };
  }
  const ext = path.extname(rawPath).toLowerCase();
  if (!GAME_EXTENSIONS.has(ext) && ext !== '') return null;
  return { path: rawPath, name: prettifyName(path.basename(rawPath, path.extname(rawPath))) };
}

function registerIpcHandlers() {
  ipcMain.handle('library:get', () => ({ ok: true, games: loadLibrary() }));

  ipcMain.handle('library:add', async (_event, paths) => {
    const games = loadLibrary();
    const known = new Set(games.map((g) => g.path));
    const added = [];
    const rejected = [];
    for (const rawPath of paths || []) {
      try {
        const resolved = await resolveGame(rawPath);
        if (!resolved) {
          rejected.push({ path: rawPath, reason: 'Not a recognized Xbox 360 game (.iso, .xex, GoD/STFS container, or extracted folder)' });
          continue;
        }
        if (known.has(resolved.path)) {
          rejected.push({ path: rawPath, reason: 'Already in your library' });
          continue;
        }
        const stat = await fsp.stat(resolved.path);
        const game = {
          id: crypto.randomUUID(),
          name: resolved.name,
          path: resolved.path,
          sizeBytes: stat.size,
          addedAt: new Date().toISOString(),
          lastPlayedAt: null,
          playCount: 0,
        };
        games.push(game);
        known.add(resolved.path);
        added.push(game);
      } catch (err) {
        rejected.push({ path: rawPath, reason: err.message });
      }
    }
    if (added.length) saveLibrary(games);
    return { ok: true, added, rejected, games };
  });

  ipcMain.handle('library:remove', (_event, id) => {
    const games = loadLibrary().filter((g) => g.id !== id);
    saveLibrary(games);
    return { ok: true, games };
  });

  ipcMain.handle('game:launch', (_event, id) => {
    const games = loadLibrary();
    const game = games.find((g) => g.id === id);
    if (!game) return { ok: false, error: 'That game is no longer in your library.' };
    if (!fs.existsSync(game.path)) {
      return { ok: false, error: `The game file has moved or been deleted:\n${game.path}` };
    }
    const settings = loadSettings();
    const exe = findCoreExe();
    if (!exe) {
      return { ok: false, error: 'The Xenia core is not installed yet — click "Install emulator core" first.' };
    }
    if (process.platform !== 'win32' && !settings.customCorePath) {
      return { ok: false, error: 'Xenia (the Xbox 360 core) only runs on Windows. On other systems, point Drop360 at a wrapper script via Settings → Locate core.' };
    }
    const args = [];
    if (settings.fullscreen) args.push('--fullscreen');
    args.push(game.path);
    const child = spawn(exe, args, { cwd: path.dirname(exe), detached: true, stdio: 'ignore' });
    child.once('error', (err) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('game:launch-error', { id, error: `Could not start the emulator core: ${err.message}` });
      }
    });
    child.unref();
    game.lastPlayedAt = new Date().toISOString();
    game.playCount += 1;
    saveLibrary(games);
    return { ok: true, game };
  });

  ipcMain.handle('game:show-in-folder', (_event, id) => {
    const game = loadLibrary().find((g) => g.id === id);
    if (game) shell.showItemInFolder(game.path);
    return { ok: true };
  });

  ipcMain.handle('dialog:add-games', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Add Xbox 360 games',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Xbox 360 games', extensions: ['iso', 'xex', 'xexp', 'zar', 'elf'] },
        { name: 'All files (GoD/STFS containers have no extension)', extensions: ['*'] },
      ],
    });
    return { ok: true, paths: result.canceled ? [] : result.filePaths };
  });

  ipcMain.handle('core:status', () => coreStatus());

  ipcMain.handle('core:download', async (_event, variantKey) => {
    const settings = loadSettings();
    const variant = CORE_VARIANTS[variantKey] || CORE_VARIANTS[settings.variant] || CORE_VARIANTS.canary;
    const zipPath = path.join(app.getPath('temp'), `drop360-xenia-${Date.now()}.zip`);
    try {
      sendProgress({ phase: 'downloading', received: 0, total: 0 });
      await download(variant.url, zipPath);
      sendProgress({ phase: 'extracting' });
      await fsp.rm(coreDir(), { recursive: true, force: true });
      await fsp.mkdir(coreDir(), { recursive: true });
      await extract(zipPath, { dir: coreDir() });
      const exe = findCoreExe();
      if (!exe) throw new Error('The downloaded archive did not contain a Xenia executable.');
      // portable.txt makes Xenia keep its config and cache next to its exe
      // instead of scattering them into Documents.
      await fsp.writeFile(path.join(path.dirname(exe), 'portable.txt'), '');
      sendProgress({ phase: 'done' });
      return coreStatus();
    } catch (err) {
      sendProgress({ phase: 'error', error: err.message });
      return { ok: false, error: err.message };
    } finally {
      await fsp.rm(zipPath, { force: true }).catch(() => {});
    }
  });

  ipcMain.handle('core:locate', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Locate your Xenia executable',
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Xenia', extensions: ['exe'] }] : [],
    });
    if (!result.canceled && result.filePaths[0]) {
      const settings = loadSettings();
      settings.customCorePath = result.filePaths[0];
      saveSettings(settings);
    }
    return coreStatus();
  });

  ipcMain.handle('settings:get', () => ({ ok: true, settings: loadSettings() }));

  ipcMain.handle('settings:set', (_event, patch) => {
    const settings = { ...loadSettings(), ...patch };
    saveSettings(settings);
    return { ok: true, settings };
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 780,
    minHeight: 520,
    backgroundColor: '#0b0f1a',
    autoHideMenuBar: true,
    title: 'Drop360',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
