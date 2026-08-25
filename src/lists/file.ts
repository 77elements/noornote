/**
 * file.ts - Shared file read/write for all lists
 *
 * Provides file-based backup storage in ~/.noornote/{npub}/ directory.
 * Each list type has its own file (tribes.json, bookmarks.json, etc.)
 *
 * Per-account isolation: Files are stored in user-specific directories.
 */

import { SystemLogger } from '../services/SystemLogger';
import { PlatformService } from '../services/PlatformService';
import { AuthService } from '../services/AuthService';

const platform = PlatformService.getInstance();
const logger = SystemLogger.getInstance();

/**
 * Verify filesystem APIs are loaded (Electron)
 */
function requireFs(): void {
  if (!window.electronAPI) throw new Error('Electron API not available');
}

/**
 * Get current user's npub
 */
function getCurrentUserNpub(): string | null {
  const user = AuthService.getInstance().getCurrentUser();
  return user?.npub ?? null;
}

/**
 * Get file path for a list file
 * Returns: ~/.noornote/{npub}/{filename}
 */
export async function getListFilePath(filename: string): Promise<string> {
  if (!platform.isDesktop) {
    throw new Error('File storage requires desktop environment');
  }

  const userNpub = getCurrentUserNpub();
  if (!userNpub) {
    throw new Error('File storage requires logged-in user');
  }

  const homePath = await window.electronAPI!.getHomeDir();
  return `${homePath}/.noornote/${userNpub}/${filename}`;
}

/**
 * Ensure directory exists for file path
 */
export async function ensureDirectoryExists(filePath: string): Promise<void> {
  requireFs();

  const dirPath = filePath.split('/').slice(0, -1).join('/');
  await window.electronAPI!.fsMkdir(dirPath);
}

/**
 * Read JSON data from file
 * Returns defaultData if file doesn't exist or on error
 */
export async function readJsonFile<T>(
  filename: string,
  defaultData: T
): Promise<T> {
  try {
    const filePath = await getListFilePath(filename);
    requireFs();

    const exists = await window.electronAPI!.fsExists(filePath);
    if (!exists) {
      logger.info('file.ts', `File not found, using defaults: ${filename}`);
      return defaultData;
    }
    const content = await window.electronAPI!.readTextFile(filePath);
    const data: T = JSON.parse(content);
    logger.info('file.ts', `Read: ${filename}`);
    return data;
  } catch (error) {
    logger.error('file.ts', `Failed to read ${String(filename)}: ${String(error)}`);
    return defaultData;
  }
}

/**
 * Write JSON data to file
 */
export async function writeJsonFile<T>(
  filename: string,
  data: T
): Promise<void> {
  try {
    const filePath = await getListFilePath(filename);
    requireFs();

    await ensureDirectoryExists(filePath);

    await window.electronAPI!.writeTextFile(
      filePath,
      JSON.stringify(data, null, 2)
    );

    logger.info('file.ts', `Wrote: ${filename}`);
  } catch (error) {
    logger.error('file.ts', `Failed to write ${String(filename)}: ${String(error)}`);
    throw error;
  }
}

/**
 * Check if file exists
 */
export async function fileExists(filename: string): Promise<boolean> {
  try {
    const filePath = await getListFilePath(filename);
    requireFs();

    return await window.electronAPI!.fsExists(filePath);
  } catch {
    return false;
  }
}

/**
 * Upload and parse JSON file via browser file dialog
 * Used in Web/Mobile mode as alternative to local file reading
 * @returns Parsed JSON data or null if cancelled/failed
 */
/**
 * Download data as JSON file via browser download dialog
 * Used in Web/Mobile mode as alternative to desktop file writing
 */
export function downloadAsJson<T>(data: T, filename: string): void {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `noornote-${filename.toLowerCase()}-${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function uploadJsonFile<T>(): Promise<T | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';

    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }

      try {
        const text = await file.text();
        const data = JSON.parse(text) as T;
        logger.info('file.ts', `Uploaded and parsed: ${file.name}`);
        resolve(data);
      } catch (error) {
        logger.error('file.ts', `Failed to parse uploaded file: ${String(error)}`);
        resolve(null);
      }
    };

    input.oncancel = () => resolve(null);
    input.click();
  });
}
