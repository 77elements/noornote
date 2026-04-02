/**
 * DiagLogExportService — Export diagnostic logs as ZIP and share/save
 *
 * Collects all log files (root + week/ + archive/), creates a ZIP,
 * then triggers the platform-appropriate save mechanism:
 * - Android (Capacitor): MediaSave plugin → Downloads folder
 * - Desktop (Electron): native save dialog
 */

import { zipSync } from 'fflate';
import { PlatformService } from './PlatformService';
import { SystemLogger } from '../components/system/SystemLogger';

const logger = SystemLogger.getInstance();
const platform = PlatformService.getInstance();

// ── Platform FS wrappers ──
let _capFsMod: typeof import('@capacitor/filesystem') | null = null;
async function getCapFs() {
  if (!_capFsMod) _capFsMod = await import('@capacitor/filesystem');
  return _capFsMod;
}

async function platformReadFile(filePath: string): Promise<Uint8Array> {
  if (platform.isElectron) {
    const buf = await window.electronAPI!.readFile(filePath);
    return new Uint8Array(buf);
  }
  if (platform.isCapacitor) {
    const { Filesystem, Directory } = await getCapFs();
    const result = await Filesystem.readFile({ path: filePath, directory: Directory.Data });
    const binary = atob(result.data as string);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  throw new Error('platformReadFile: not available');
}

async function platformReadDir(dirPath: string): Promise<Array<{ name: string; isFile: boolean }>> {
  if (platform.isElectron) return window.electronAPI!.readDir(dirPath);
  if (platform.isCapacitor) {
    const { Filesystem, Directory } = await getCapFs();
    const result = await Filesystem.readdir({ path: dirPath, directory: Directory.Data });
    return result.files.map(f => ({ name: f.name, isFile: f.type === 'file' }));
  }
  throw new Error('platformReadDir: not available');
}

async function platformExists(path: string): Promise<boolean> {
  if (platform.isElectron) return window.electronAPI!.fsExists(path);
  if (platform.isCapacitor) {
    try {
      const { Filesystem, Directory } = await getCapFs();
      await Filesystem.stat({ path, directory: Directory.Data });
      return true;
    } catch { return false; }
  }
  return false;
}

async function platformHomeDir(): Promise<string> {
  if (platform.isElectron) return window.electronAPI!.getHomeDir();
  throw new Error('platformHomeDir: not available');
}

async function platformSaveFileDialog(filename: string): Promise<string | null> {
  if (platform.isElectron) {
    return window.electronAPI!.saveFileDialog({
      defaultPath: filename,
      filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
    });
  }
  throw new Error('platformSaveFileDialog: not available');
}

async function platformWriteFile(filePath: string, data: Uint8Array): Promise<void> {
  if (platform.isElectron) return window.electronAPI!.writeFile(filePath, data);
  throw new Error('platformWriteFile: not available');
}

/**
 * Export all diagnostic logs as a ZIP file and share/save it.
 * Call from Settings UI.
 */
export async function exportDiagnosticLogs(): Promise<boolean> {
  try {
    logger.info('DiagLogExport', 'Collecting logs...');

    // 1. Flush buffered logs before collecting
    const { diagLog } = await import('./DiagnosticLogger');
    diagLog('crashes', 'Log export triggered');

    // 2. Collect all log files
    const { files, debugInfo } = await collectLogFiles();
    if (Object.keys(files).length === 0) {
      (exportDiagnosticLogs as any).lastDebugInfo = debugInfo;
      logger.warn('DiagLogExport', `No logs: ${debugInfo}`);
      return false;
    }

    // 3. Create ZIP
    const zipData = zipSync(files, { level: 6 });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `noornote-logs-${timestamp}.zip`;

    logger.info('DiagLogExport', `ZIP ready — ${(zipData.length / 1024).toFixed(1)} KB, ${Object.keys(files).length} files`);

    // 4. Save (platform-specific)
    if (platform.isAndroid) {
      return await saveToDownloads(zipData, filename);
    } else {
      return await saveViaDialog(zipData, filename);
    }
  } catch (error) {
    (exportDiagnosticLogs as any).lastDebugInfo = `THROW: ${error}`;
    logger.error('DiagLogExport', `Export failed: ${error}`);
    return false;
  }
}

async function collectLogFiles(): Promise<{ files: Record<string, Uint8Array>; debugInfo: string }> {
  const logsDir = await getLogsDir();
  if (!logsDir) return { files: {}, debugInfo: 'no logsDir' };

  const files: Record<string, Uint8Array> = {};
  const debug: string[] = [];

  const subdirs = [
    { path: logsDir, prefix: '' },
    { path: `${logsDir}/week`, prefix: 'week/' },
    { path: `${logsDir}/archive`, prefix: 'archive/' },
  ];

  for (const { path, prefix } of subdirs) {
    if (!(await platformExists(path))) {
      debug.push(`${prefix || 'root'}:missing`);
      continue;
    }

    const entries = await platformReadDir(path);
    const names = entries.map(e => `${e.name}(file=${e.isFile})`);
    debug.push(`${prefix || 'root'}:[${names.join(',')}]`);

    for (const entry of entries) {
      if (!entry.name.endsWith('.jsonl') && !entry.name.endsWith('.jsonl.gz')) continue;

      try {
        const data = await platformReadFile(`${path}/${entry.name}`);
        files[`${prefix}${entry.name}`] = data;
      } catch {
        // Skip unreadable files
      }
    }
  }

  return { files, debugInfo: debug.join(' | ') };
}

async function getLogsDir(): Promise<string | null> {
  if (platform.isCapacitor) {
    return 'logs'; // Relative to Directory.Data
  }

  const { AuthService } = await import('./AuthService');
  const user = AuthService.getInstance().getCurrentUser();
  if (!user?.npub) return null;

  const home = await platformHomeDir();
  return `${home}/.noornote/${user.npub}/logs`;
}

/**
 * Android (Capacitor): Save to Downloads via MediaSave plugin.
 */
async function saveToDownloads(zipData: Uint8Array, filename: string): Promise<boolean> {
  const CHUNK = 8192;
  let binary = '';
  for (let i = 0; i < zipData.length; i += CHUNK) {
    binary += String.fromCharCode(...zipData.subarray(i, i + CHUNK));
  }
  const base64 = btoa(binary);

  const { registerPlugin } = await import('@capacitor/core');
  const MediaSave = registerPlugin('MediaSave');
  await (MediaSave as any).saveToDownloads({ filename, data: base64, mimeType: 'application/zip' });

  logger.success('DiagLogExport', `Logs exported to Downloads — ${filename}`);
  return true;
}

/**
 * Desktop (Electron): Save via native dialog.
 */
async function saveViaDialog(zipData: Uint8Array, filename: string): Promise<boolean> {
  const filePath = await platformSaveFileDialog(filename);

  if (!filePath) {
    logger.info('DiagLogExport', 'Save cancelled');
    return false;
  }

  await platformWriteFile(filePath, zipData);
  logger.success('DiagLogExport', `Logs saved`);
  return true;
}
