const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('drop360', {
  getLibrary: () => ipcRenderer.invoke('library:get'),
  addGames: (paths) => ipcRenderer.invoke('library:add', paths),
  removeGame: (id) => ipcRenderer.invoke('library:remove', id),
  launchGame: (id) => ipcRenderer.invoke('game:launch', id),
  showInFolder: (id) => ipcRenderer.invoke('game:show-in-folder', id),
  browseForGames: () => ipcRenderer.invoke('dialog:add-games'),
  getCoreStatus: () => ipcRenderer.invoke('core:status'),
  downloadCore: (variant) => ipcRenderer.invoke('core:download', variant),
  locateCore: () => ipcRenderer.invoke('core:locate'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  // Sandboxed renderers can't read real paths off File objects; webUtils can.
  pathForFile: (file) => webUtils.getPathForFile(file),
  onCoreProgress: (callback) => ipcRenderer.on('core:progress', (_event, progress) => callback(progress)),
  onLaunchError: (callback) => ipcRenderer.on('game:launch-error', (_event, payload) => callback(payload)),
});
