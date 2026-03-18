/**
 * DiagLogExportService — Export diagnostic logs as ZIP and share/save
 *
 * Collects all log files (root + week/ + archive/), creates a ZIP,
 * then triggers the platform-appropriate save mechanism:
 * - Android: Blob download via <a> tag → Downloads folder
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
    logger.info('DiagLogExport', 'Collecting logs...');

    // 1. Flush buffered logs before collecting
    const { diagLog } = await import('./DiagnosticLogger');
    diagLog('crashes', 'Log export triggered');

    // 2. Collect all log files
    const files = await collectLogFiles();
    if (Object.keys(files).length === 0) {
      logger.warn('DiagLogExport', 'No log files found');
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

  const logsDir = await getLogsDir();
  if (!logsDir) return {};

  const files: Record<string, Uint8Array> = {};

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
 * Android: {appDataDir}/logs/ (no npub nesting)
 * Desktop: ~/.noornote/{npub}/logs/
 */
async function getLogsDir(): Promise<string | null> {
  if (platform.isAndroid) {
    const { appDataDir } = await import('@tauri-apps/api/path');
    const base = (await appDataDir()).replace(/\/+$/, '');
    return `${base}/logs`;
  }

  const { AuthService } = await import('./AuthService');
  const user = AuthService.getInstance().getCurrentUser();
  if (!user?.npub) return null;

  const { homeDir } = await import('@tauri-apps/api/path');
  const home = await homeDir();
  return `${home}/.noornote/${user.npub}/logs`;
}

/**
 * Android: Trigger download via Blob URL + <a> click.
 * This works in any WebView — the Android download manager picks it up
 * and saves it to the Downloads folder.
 */
async function saveToDownloads(zipData: Uint8Array, filename: string): Promise<boolean> {
  const { writeFile } = await import('@tauri-apps/plugin-fs');
  const { downloadDir } = await import('@tauri-apps/api/path');
  const dir = (await downloadDir()).replace(/\/+$/, '');
  await writeFile(`${dir}/${filename}`, zipData);
  logger.success('DiagLogExport', `Logs exported — ${filename}`);
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
    logger.info('DiagLogExport', 'Save cancelled');
    return false;
  }

  await writeFile(filePath, zipData);
  logger.success('DiagLogExport', `Logs saved`);
  return true;
}
