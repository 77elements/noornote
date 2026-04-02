/**
 * Type declarations for Electron preload API (window.electronAPI)
 * Matches the channels exposed in electron/preload.cjs
 */

interface ElectronAPI {
  // NoorSigner
  keySignerRequest: (request: string) => Promise<string>;
  launchKeySigner: (mode: string) => Promise<void>;
  checkTrustSession: () => Promise<boolean>;
  cancelKeySignerLaunch: () => Promise<void>;
  ensureNoorSignerInstalled: () => Promise<string>;
  addAccountViaCli: (jsonInput: string) => Promise<string>;
  launchDaemonSilent: () => Promise<void>;
  hasNoorSignerAccounts: () => Promise<boolean>;
  launchDaemonWithPassword: (password: string) => Promise<string>;
  prepareDaemonForUnlock: () => Promise<void>;
  submitDaemonPassword: (password: string) => Promise<string>;
  removeNoorSignerAccount: (npub: string) => Promise<void>;
  checkICloudKeychain: () => Promise<boolean>;

  // File System
  readTextFile: (filePath: string) => Promise<string>;
  writeTextFile: (filePath: string, contents: string) => Promise<void>;
  readFile: (filePath: string) => Promise<ArrayBuffer>;
  fsExists: (filePath: string) => Promise<boolean>;
  fsMkdir: (dirPath: string) => Promise<void>;
  readDir: (dirPath: string) => Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean }>>;
  fsRemove: (filePath: string) => Promise<void>;
  writeFile: (filePath: string, data: Uint8Array) => Promise<void>;
  fsAppendFile: (filePath: string, contents: string) => Promise<void>;
  fsRename: (oldPath: string, newPath: string) => Promise<void>;

  // Path Resolution
  getHomeDir: () => Promise<string>;
  getAppDataDir: () => Promise<string>;

  // Dialog
  saveFileDialog: (options?: { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }>; title?: string }) => Promise<string | null>;

  // Shell
  openExternal: (url: string) => Promise<void>;

  // Window
  setBadgeCount: (count: number) => Promise<void>;
  getWindowSize: () => Promise<[number, number]>;
  setWindowSize: (width: number, height: number) => Promise<void>;

  // App
  getVersion: () => Promise<string>;

  // Events (return unsubscribe function)
  onDeepLink: (callback: (url: string) => void) => () => void;
  onGlobalShortcut: (callback: (action: string) => void) => () => void;
  onCloseRequested: (callback: () => void) => () => void;
}

interface Window {
  electronAPI?: ElectronAPI;
}
