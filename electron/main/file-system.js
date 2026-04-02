/**
 * File System IPC Handlers for Electron
 * Replaces @tauri-apps/plugin-fs for desktop file operations.
 *
 * Used by: EncryptedFileStorage, BaseFileStorage, DiagnosticLogger,
 *          DiagLogExportService, list file sync, ProfileRecognition
 */

import { ipcMain, app, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function registerFileSystemHandlers() {

  // Read text file
  ipcMain.handle('fs:read-text-file', async (_event, filePath) => {
    return fs.promises.readFile(filePath, 'utf-8');
  });

  // Write text file (creates parent dirs if needed)
  ipcMain.handle('fs:write-text-file', async (_event, filePath, contents) => {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    await fs.promises.writeFile(filePath, contents, 'utf-8');
  });

  // Read binary file (returns ArrayBuffer for renderer)
  ipcMain.handle('fs:read-file', async (_event, filePath) => {
    const buffer = await fs.promises.readFile(filePath);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  });

  // Check if path exists
  ipcMain.handle('fs:exists', async (_event, filePath) => {
    return fs.existsSync(filePath);
  });

  // Create directory (recursive)
  ipcMain.handle('fs:mkdir', async (_event, dirPath) => {
    fs.mkdirSync(dirPath, { recursive: true });
  });

  // Read directory entries
  ipcMain.handle('fs:read-dir', async (_event, dirPath) => {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries.map(e => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isFile: e.isFile(),
    }));
  });

  // Write binary file (creates parent dirs if needed)
  ipcMain.handle('fs:write-file', async (_event, filePath, data) => {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    await fs.promises.writeFile(filePath, Buffer.from(data));
  });

  // Append text to file (creates if needed)
  ipcMain.handle('fs:append-file', async (_event, filePath, contents) => {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    await fs.promises.appendFile(filePath, contents, 'utf-8');
  });

  // Rename/move file
  ipcMain.handle('fs:rename', async (_event, oldPath, newPath) => {
    await fs.promises.rename(oldPath, newPath);
  });

  // Remove file or directory
  ipcMain.handle('fs:remove', async (_event, filePath) => {
    const stat = fs.statSync(filePath, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isDirectory()) {
      fs.rmSync(filePath, { recursive: true });
    } else {
      fs.unlinkSync(filePath);
    }
  });

  // ── Path Resolution ──

  // Get home directory (~)
  ipcMain.handle('path:home-dir', async () => {
    return os.homedir();
  });

  // Get app data directory (platform-specific)
  ipcMain.handle('path:app-data-dir', async () => {
    return app.getPath('appData');
  });

  // ── Dialog ──

  // Save file dialog (returns selected path or null)
  ipcMain.handle('dialog:save', async (_event, options) => {
    const result = await dialog.showSaveDialog({
      defaultPath: options?.defaultPath,
      filters: options?.filters,
      title: options?.title,
    });
    return result.canceled ? null : result.filePath;
  });
}
