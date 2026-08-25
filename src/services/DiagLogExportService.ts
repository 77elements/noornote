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
import { SystemLogger } from './SystemLogger';

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
    const result = await Filesystem.readFile({
      path: filePath,
      directory: Directory.Data,
    });
    const binary = atob(result.data as string);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  throw new Error('platformReadFile: not available');
}

async function platformReadDir(
  dirPath: string
): Promise<Array<{ name: string; isFile: boolean }>> {
  if (platform.isElectron) return window.electronAPI!.readDir(dirPath);
  if (platform.isCapacitor) {
    const { Filesystem, Directory } = await getCapFs();
    const result = await Filesystem.readdir({
      path: dirPath,
      directory: Directory.Data,
    });
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
    } catch {
      return false;
    }
  }
  return false;
}

async function platformHomeDir(): Promise<string> {
  if (platform.isElectron) return window.electronAPI!.getHomeDir();
  throw new Error('platformHomeDir: not available');
}

async function platformSaveFileDialog(
  filename: string
): Promise<string | null> {
  if (platform.isElectron) {
    return window.electronAPI!.saveFileDialog({
      defaultPath: filename,
      filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
    });
  }
  throw new Error('platformSaveFileDialog: not available');
}

async function platformWriteFile(
  filePath: string,
  data: Uint8Array
): Promise<void> {
  if (platform.isElectron) return window.electronAPI!.writeFile(filePath, data);
  throw new Error('platformWriteFile: not available');
}

/**
 * Drive an "Export DiagLogs" button through the full export UX:
 * disable + relabel to 'Exporting...', run exportDiagnosticLogs(),
 * toast success/error, restore the resting label in finally.
 *
 * Single source for every place that mounts an export button
 * (SettingsView, MainLayout SCC) — keeps the click UX identical.
 */
export async function runDiagLogExportFromButton(
  btn: HTMLButtonElement,
  restingLabel: string
): Promise<void> {
  btn.disabled = true;
  btn.textContent = 'Exporting...';
  try {
    const { DiagnosticLogger } = await import('./DiagnosticLogger');
    const { ToastService } = await import('./ToastService');
    const status = DiagnosticLogger.getInstance().getStatus();

    if (!status.initialized && !platform.isCapacitor && !platform.isBrowser) {
      const reason = status.error || 'Logger not initialized';
      ToastService.show(`DiagLog: ${reason}`, 'error', 8000);
      return;
    }

    let exportError: string | null = null;
    let success = false;
    try {
      success = await exportDiagnosticLogs();
    } catch (e) {
      exportError = String(e);
    }

    if (success) {
      ToastService.show('Logs exported', 'success');
    } else {
      const debugInfo = lastExportDebugInfo;
      ToastService.show(
        exportError || debugInfo || 'export returned false',
        'error',
        15000
      );
    }
  } catch (error) {
    const { ToastService } = await import('./ToastService');
    ToastService.show(`Import error: ${String(error)}`, 'error', 15000);
  } finally {
    btn.disabled = false;
    btn.textContent = restingLabel;
  }
}

/**
 * Export all diagnostic logs as a ZIP file and share/save it.
 * Call from Settings UI.
 */
/**
 * Debug info from the last export attempt — read by the Settings error toast
 * right after exportDiagnosticLogs() returns false, to explain the failure.
 */
let lastExportDebugInfo = '';

export async function exportDiagnosticLogs(): Promise<boolean> {
  try {
    logger.info('DiagLogExport', 'Collecting logs...');

    // 1. Flush buffered logs before collecting
    const { diagLog } = await import('./DiagnosticLogger');
    diagLog('crashes', 'Log export triggered');

    // 2. Collect log data (web: IndexedDB ring, native: filesystem)
    const isWeb = platform.isBrowser;
    const collected = isWeb
      ? await collectWebLogFiles()
      : await collectLogFiles();
    if (Object.keys(collected.files).length === 0) {
      lastExportDebugInfo = collected.debugInfo;
      logger.warn('DiagLogExport', `No logs: ${collected.debugInfo}`);
      return false;
    }

    // 3. Create ZIP
    const zipData = zipSync(collected.files, { level: 6 });
    // Release the raw log bytes now that the zip is built. The chunked save
    // below is async and long-running; without this the ~raw-log-sized files
    // map stays alive in the closure and stacks on top of zipData, which has
    // OOM'd the 256MB WebView heap on large log sets.
    collected.files = {};
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, 19);
    const filename = `noornote-logs-${timestamp}.zip`;

    logger.info(
      'DiagLogExport',
      `ZIP ready — ${(zipData.length / 1024).toFixed(1)} KB`
    );

    // 4. Save (platform-specific)
    if (isWeb) {
      const ok = downloadBlob(zipData, filename);
      if (ok) logger.success('DiagLogExport', `Logs downloaded — ${filename}`);
      return ok;
    }
    if (platform.isAndroid) {
      return await saveToDownloads(zipData, filename);
    }
    return await saveViaDialog(zipData, filename);
  } catch (error) {
    lastExportDebugInfo = `THROW: ${String(error)}`;
    logger.error('DiagLogExport', `Export failed: ${String(error)}`);
    return false;
  }
}

async function collectLogFiles(): Promise<{
  files: Record<string, Uint8Array>;
  debugInfo: string;
}> {
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
      if (!entry.name.endsWith('.jsonl') && !entry.name.endsWith('.jsonl.gz'))
        continue;

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
 * Web: collect logs from the IndexedDB ring buffer (DiagWebStore). Lines are
 * grouped by date (parsed from each entry's ISO `ts`) to synthesize
 * `{area}-{date}.jsonl` filenames identical to Desktop's daily files, so the
 * diagnose/*.py tooling consumes web exports unchanged.
 */
async function collectWebLogFiles(): Promise<{
  files: Record<string, Uint8Array>;
  debugInfo: string;
}> {
  const { diagWebStore } = await import('./DiagWebStore');
  const all = await diagWebStore.readAll();
  const files: Record<string, Uint8Array> = {};
  const debug: string[] = [];
  const encoder = new TextEncoder();

  for (const [area, lines] of Object.entries(all)) {
    if (!lines || lines.length === 0) continue;

    // Bucket lines by date so each day becomes its own .jsonl, like Desktop.
    const byDate = new Map<string, string[]>();
    for (const line of lines) {
      let date = 'unknown';
      try {
        const parsed = JSON.parse(line) as { ts?: string | number };
        if (parsed?.ts) date = String(parsed.ts).slice(0, 10);
      } catch {
        /* unparsable line → 'unknown' bucket */
      }
      const bucket = byDate.get(date) || [];
      bucket.push(line);
      byDate.set(date, bucket);
    }

    let areaCount = 0;
    for (const [date, dateLines] of byDate) {
      const name =
        date === 'unknown' ? `${area}.jsonl` : `${area}-${date}.jsonl`;
      files[name] = encoder.encode(`${dateLines.join('\n')}\n`);
      areaCount += dateLines.length;
    }
    debug.push(`${area}:${areaCount}`);
  }

  return { files, debugInfo: debug.join(' | ') || 'empty' };
}

/**
 * Web: browser download via Blob URL + a hidden <a download>. The simplest of
 * the three platform paths — no base64 bridge, no native plugin, no OOM risk.
 */
function downloadBlob(data: Uint8Array, filename: string): boolean {
  const blob = new Blob([data as BlobPart], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revoke so the browser can start the download from the URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

/**
 * Android (Capacitor): chunk-write the zip to a Cache file (small base64 blocks,
 * never one giant string), then ask the native MediaSave plugin to copy that
 * file into Downloads by path. The previous approach built one ~log-sized
 * binary string and btoa()'d it — a single 65MB+ allocation that OOM'd the
 * 256MB WebView heap. Streaming through a Cache file keeps peak JS heap at
 * roughly zipData + one small chunk.
 */
async function saveToDownloads(
  zipData: Uint8Array,
  filename: string
): Promise<boolean> {
  const { Filesystem, Directory } = await getCapFs();

  // Multiple of 3 so each chunk base64-encodes cleanly with no padding glue.
  // 24KB keeps String.fromCharCode's argument count far under the engine limit.
  const CHUNK = 24576;
  const tempPath = `nn-export/${filename}`;
  let first = true;
  for (let i = 0; i < zipData.length; i += CHUNK) {
    const slice = zipData.subarray(i, i + CHUNK);
    const b64 = btoa(String.fromCharCode(...slice));
    if (first) {
      await Filesystem.writeFile({
        path: tempPath,
        data: b64,
        directory: Directory.Cache,
        recursive: true,
      });
      first = false;
    } else {
      await Filesystem.appendFile({
        path: tempPath,
        data: b64,
        directory: Directory.Cache,
      });
    }
  }
  if (first) {
    // Empty zip — create the file so the native copy has a source.
    await Filesystem.writeFile({
      path: tempPath,
      data: '',
      directory: Directory.Cache,
      recursive: true,
    });
  }

  try {
    const { uri } = await Filesystem.getUri({
      path: tempPath,
      directory: Directory.Cache,
    });
    const { registerPlugin } = await import('@capacitor/core');
    // Custom Capacitor plugin (MediaSave) declared in android/ — not in the
    // official plugin types, hence the narrow local interface.
    const MediaSave = registerPlugin<{
      saveFileToDownloads(options: {
        fileUri: string;
        filename: string;
        mimeType: string;
      }): Promise<void>;
    }>('MediaSave');
    await MediaSave.saveFileToDownloads({
      fileUri: uri,
      filename,
      mimeType: 'application/zip',
    });

    logger.success('DiagLogExport', `Logs exported to Downloads — ${filename}`);
    return true;
  } finally {
    // Remove the temp cache file whether the copy succeeded or failed.
    await Filesystem.deleteFile({
      path: tempPath,
      directory: Directory.Cache,
    }).catch(() => {});
  }
}

/**
 * Desktop (Electron): Save via native dialog.
 */
async function saveViaDialog(
  zipData: Uint8Array,
  filename: string
): Promise<boolean> {
  const filePath = await platformSaveFileDialog(filename);

  if (!filePath) {
    logger.info('DiagLogExport', 'Save cancelled');
    return false;
  }

  await platformWriteFile(filePath, zipData);
  logger.success('DiagLogExport', `Logs saved`);
  return true;
}
