/**
 * DiagLogExportService — Export diagnostic logs as ZIP and share/save
 *
 * Collects all log files (root + week/ + archive/), creates a ZIP,
 * then triggers the platform-appropriate share/save mechanism:
 * - Android: navigator.share() → Share dialog (Signal, Email, etc.)
 * - Desktop: tauri-plugin-dialog save dialog
 */

import { zipSync } from 'fflate';
import { PlatformService } from './PlatformService';
import { SystemLogger } from '../components/system/SystemLogger';

const logger = SystemLogger.getInstance();
const platform = PlatformService.getInstance();

/**
 * Export all diagnostic logs as a ZIP file and share/save it.
 * Call from Settings UI.
 */
export async function exportDiagnosticLogs(): Promise<boolean> {
  try {
    logger.info('DiagLogExport', 'Starting log export...');

    // 1. Collect all log files
    const files = await collectLogFiles();
    if (Object.keys(files).length === 0) {
      logger.warn('DiagLogExport', 'No log files found');
      return false;
    }

    // 2. Create ZIP
    const zipData = zipSync(files, { level: 6 });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `noornote-logs-${timestamp}.zip`;

    logger.info('DiagLogExport', `Created ZIP: ${filename} (${(zipData.length / 1024).toFixed(1)} KB, ${Object.keys(files).length} files)`);

    // 3. Share or save
    if (platform.isAndroid) {
      return await shareViaNavigator(zipData, filename);
    } else {
      return await saveViaDialog(zipData, filename);
    }
  } catch (error) {
    logger.error('DiagLogExport', `Export failed: ${error}`);
    return false;
  }
}

/**
 * Collect all log files from root/, week/, archive/ into a flat structure for ZIP.
 * Returns { "filename": Uint8Array } for fflate's zipSync.
 */
async function collectLogFiles(): Promise<Record<string, Uint8Array>> {
  const { readDir, readFile, exists } = await import('@tauri-apps/plugin-fs');

  // Get logs directory from DiagnosticLogger
  const logsDir = await getLogsDir();
  if (!logsDir) return {};

  const files: Record<string, Uint8Array> = {};

  // Collect from root, week/, archive/
  const subdirs = [
    { path: logsDir, prefix: '' },
    { path: `${logsDir}/week`, prefix: 'week/' },
    { path: `${logsDir}/archive`, prefix: 'archive/' },
  ];

  for (const { path, prefix } of subdirs) {
    if (!(await exists(path))) continue;

    const entries = await readDir(path);
    for (const entry of entries) {
      if (!entry.isFile) continue;
      if (!entry.name.endsWith('.jsonl') && !entry.name.endsWith('.jsonl.gz')) continue;

      try {
        const data = await readFile(`${path}/${entry.name}`);
        files[`${prefix}${entry.name}`] = new Uint8Array(data);
      } catch {
        // Skip unreadable files
      }
    }
  }

  return files;
}

/**
 * Get the logs directory path.
 */
async function getLogsDir(): Promise<string | null> {
  const { AuthService } = await import('./AuthService');
  const user = AuthService.getInstance().getCurrentUser();
  if (!user?.npub) return null;

  if (platform.isAndroid) {
    const { appDataDir } = await import('@tauri-apps/api/path');
    const base = await appDataDir();
    return `${base}logs`;
  } else {
    const { homeDir } = await import('@tauri-apps/api/path');
    const home = await homeDir();
    return `${home}/.noornote/${user.npub}/logs`;
  }
}

/**
 * Android: Share via navigator.share() — opens native share dialog.
 */
async function shareViaNavigator(zipData: Uint8Array, filename: string): Promise<boolean> {
  if (!navigator.share) {
    logger.error('DiagLogExport', 'navigator.share not available');
    return false;
  }

  const file = new File([zipData as BlobPart], filename, { type: 'application/zip' });

  await navigator.share({
    title: 'Noornote Diagnostic Logs',
    files: [file],
  });

  logger.info('DiagLogExport', 'Shared via navigator.share');
  return true;
}

/**
 * Desktop: Save via Tauri dialog.
 */
async function saveViaDialog(zipData: Uint8Array, filename: string): Promise<boolean> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  const { writeFile } = await import('@tauri-apps/plugin-fs');

  const filePath = await save({
    defaultPath: filename,
    filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
  });

  if (!filePath) {
    logger.info('DiagLogExport', 'Save dialog cancelled');
    return false;
  }

  await writeFile(filePath, zipData);
  logger.info('DiagLogExport', `Saved to ${filePath}`);
  return true;
}
