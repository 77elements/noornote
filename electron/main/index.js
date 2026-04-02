/**
 * Electron Main Process
 * Electron Main Process — app lifecycle, window, shortcuts, deep links, IPC.
 */

import { app, BrowserWindow, globalShortcut, ipcMain, screen, session, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerKeySignerHandlers } from './key-signer.js';
import { registerFileSystemHandlers } from './file-system.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

let mainWindow = null;
let forceQuit = false;

// ── Single Instance Lock ──

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

app.on('second-instance', (_event, commandLine) => {
  // Deep link from second instance (Linux)
  const url = commandLine.find(arg => arg.startsWith('nostr:'));
  if (url && mainWindow) {
    mainWindow.webContents.send('deep-link', url);
  }
  // Focus existing window
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// ── Deep Link Protocol ──

app.setAsDefaultProtocolClient('nostr');

// macOS: deep link via open-url event
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (mainWindow) {
    mainWindow.webContents.send('deep-link', url);
  }
});

// ── App Lifecycle ──

app.whenReady().then(() => {
  // Register IPC handlers before creating window
  registerKeySignerHandlers();
  registerFileSystemHandlers();
  registerAppHandlers();

  // CSP — 'unsafe-eval' required by NDK's tseep event emitter (uses new Function())
  // Dev mode additionally needs ws: for Vite HMR
  const connectSrc = isDev
    ? " connect-src 'self' wss: ws: https: http://localhost:*;"
    : " connect-src 'self' wss: https:;";

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self';" +
          " script-src 'self' 'unsafe-eval';" +
          " style-src 'self' 'unsafe-inline';" +
          connectSrc +
          " img-src 'self' https: data: blob:;" +
          " media-src 'self' https: blob:;" +
          " font-src 'self';" +
          " worker-src 'self' blob:;" +
          " frame-src https://www.youtube.com https://youtube.com"
        ],
      },
    });
  });

  createWindow();

  // Global Shortcuts (Super+Enter, Super+K, Super+Left, Super+Right)
  globalShortcut.register('CommandOrControl+Return', () => {
    mainWindow?.webContents.send('global-shortcut', 'search');
  });
  globalShortcut.register('CommandOrControl+K', () => {
    mainWindow?.webContents.send('global-shortcut', 'search-alt');
  });
  globalShortcut.register('CommandOrControl+Left', () => {
    mainWindow?.webContents.send('global-shortcut', 'navigate-back');
  });
  globalShortcut.register('CommandOrControl+Right', () => {
    mainWindow?.webContents.send('global-shortcut', 'navigate-forward');
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// macOS: dock click → restore window
app.on('activate', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
});

app.on('before-quit', () => {
  forceQuit = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// ── Window Creation ──

function createWindow() {
  const preloadPath = path.join(__dirname, '..', 'preload.cjs');

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 1200,
    minWidth: 1200,
    minHeight: 800,
    title: 'NoorNote',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // Required for preload to access Node.js APIs
    },
  });

  // User agent
  const version = app.getVersion();
  mainWindow.webContents.setUserAgent(`NoorNote/${version}`);

  // macOS: minimize on window close button, but allow CMD+Q / Menu > Quit
  mainWindow.on('close', (event) => {
    if (process.platform === 'darwin' && !forceQuit) {
      event.preventDefault();
      mainWindow.minimize();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Load content
  if (isDev) {
    mainWindow.loadURL('http://localhost:3000');

    // Dev mode window sizing
    const devMode = process.env.ELECTRON_DEV_MODE || 'wide';
    if (devMode === 'wide') {
      const display = screen.getPrimaryDisplay();
      const { width: screenW } = display.workAreaSize;
      mainWindow.setSize(Math.min(screenW - 50, 1800), 1200);
      mainWindow.center();
    }

    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
  }
}

// ── App-Level IPC Handlers ──

function registerAppHandlers() {
  ipcMain.handle('shell:open-external', async (_event, url) => {
    await shell.openExternal(url);
  });

  ipcMain.handle('window:set-badge-count', async (_event, count) => {
    app.setBadgeCount(count);
  });

  ipcMain.handle('window:get-size', async () => {
    if (!mainWindow) return [0, 0];
    return mainWindow.getSize();
  });

  ipcMain.handle('window:set-size', async (_event, width, height) => {
    if (mainWindow) {
      mainWindow.setSize(width, height);
    }
  });

  ipcMain.handle('app:get-version', async () => {
    return app.getVersion();
  });
}
