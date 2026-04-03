/**
 * Electron Preload Script
 * Exposes window.electronAPI via contextBridge for secure IPC.
 *
 * This is the security boundary between the renderer (web content)
 * and the main process (Node.js). Only explicitly listed channels
 * are exposed — no raw ipcRenderer access.
 */

const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Expose cache clearing for periodic memory management
window.__electronClearCache = () => {
  webFrame.clearCache();
};

contextBridge.exposeInMainWorld('electronAPI', {

  // ── NoorSigner ──

  keySignerRequest: (request) =>
    ipcRenderer.invoke('key-signer:request', request),

  launchKeySigner: (mode) =>
    ipcRenderer.invoke('key-signer:launch', mode),

  checkTrustSession: () =>
    ipcRenderer.invoke('key-signer:check-trust-session'),

  cancelKeySignerLaunch: () =>
    ipcRenderer.invoke('key-signer:cancel-launch'),

  ensureNoorSignerInstalled: () =>
    ipcRenderer.invoke('key-signer:ensure-installed'),

  addAccountViaCli: (jsonInput) =>
    ipcRenderer.invoke('key-signer:add-account', jsonInput),

  launchDaemonSilent: () =>
    ipcRenderer.invoke('key-signer:launch-daemon-silent'),

  hasNoorSignerAccounts: () =>
    ipcRenderer.invoke('key-signer:has-accounts'),

  launchDaemonWithPassword: (password) =>
    ipcRenderer.invoke('key-signer:launch-daemon-with-password', password),

  prepareDaemonForUnlock: () =>
    ipcRenderer.invoke('key-signer:prepare-unlock'),

  submitDaemonPassword: (password) =>
    ipcRenderer.invoke('key-signer:submit-password', password),

  removeNoorSignerAccount: (npub) =>
    ipcRenderer.invoke('key-signer:remove-account', npub),

  checkICloudKeychain: () =>
    ipcRenderer.invoke('key-signer:check-icloud-keychain'),

  // ── File System ──

  readTextFile: (filePath) =>
    ipcRenderer.invoke('fs:read-text-file', filePath),

  writeTextFile: (filePath, contents) =>
    ipcRenderer.invoke('fs:write-text-file', filePath, contents),

  readFile: (filePath) =>
    ipcRenderer.invoke('fs:read-file', filePath),

  fsExists: (filePath) =>
    ipcRenderer.invoke('fs:exists', filePath),

  fsMkdir: (dirPath) =>
    ipcRenderer.invoke('fs:mkdir', dirPath),

  readDir: (dirPath) =>
    ipcRenderer.invoke('fs:read-dir', dirPath),

  fsRemove: (filePath) =>
    ipcRenderer.invoke('fs:remove', filePath),

  writeFile: (filePath, data) =>
    ipcRenderer.invoke('fs:write-file', filePath, data),

  fsAppendFile: (filePath, contents) =>
    ipcRenderer.invoke('fs:append-file', filePath, contents),

  fsRename: (oldPath, newPath) =>
    ipcRenderer.invoke('fs:rename', oldPath, newPath),

  // ── Path Resolution ──

  getHomeDir: () =>
    ipcRenderer.invoke('path:home-dir'),

  getAppDataDir: () =>
    ipcRenderer.invoke('path:app-data-dir'),

  // ── Dialog ──

  saveFileDialog: (options) =>
    ipcRenderer.invoke('dialog:save', options),

  // ── Shell ──

  openExternal: (url) =>
    ipcRenderer.invoke('shell:open-external', url),

  // ── Window ──

  setBadgeCount: (count) =>
    ipcRenderer.invoke('window:set-badge-count', count),

  getWindowSize: () =>
    ipcRenderer.invoke('window:get-size'),

  setWindowSize: (width, height) =>
    ipcRenderer.invoke('window:set-size', width, height),

  // ── App Info ──

  getVersion: () =>
    ipcRenderer.invoke('app:get-version'),

  // ── Events (Main → Renderer) ──

  onDeepLink: (callback) => {
    const handler = (_event, url) => callback(url);
    ipcRenderer.on('deep-link', handler);
    return () => ipcRenderer.removeListener('deep-link', handler);
  },

  onGlobalShortcut: (callback) => {
    const handler = (_event, action) => callback(action);
    ipcRenderer.on('global-shortcut', handler);
    return () => ipcRenderer.removeListener('global-shortcut', handler);
  },

  onCloseRequested: (callback) => {
    const handler = (_event) => callback();
    ipcRenderer.on('close-requested', handler);
    return () => ipcRenderer.removeListener('close-requested', handler);
  },
});
