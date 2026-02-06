/**
 * file.ts - Shared Tauri file read/write for all lists
 *
 * Provides file-based backup storage in ~/.noornote/{npub}/ directory.
 * Each list type has its own file (tribes.json, bookmarks.json, etc.)
 *
 * Per-account isolation: Files are stored in user-specific directories.
 */

import { SystemLogger } from '../components/system/SystemLogger';
import { PlatformService } from '../services/PlatformService';
import { AuthService } from '../services/AuthService';

// Tauri APIs (dynamically imported to support browser builds)
let tauriHomeDir: typeof import('@tauri-apps/api/path').homeDir | null = null;
let tauriReadTextFile: typeof import('@tauri-apps/plugin-fs').readTextFile | null = null;
let tauriWriteTextFile: typeof import('@tauri-apps/plugin-fs').writeTextFile | null = null;
let tauriExists: typeof import('@tauri-apps/plugin-fs').exists | null = null;
let tauriMkdir: typeof import('@tauri-apps/plugin-fs').mkdir | null = null;

const platform = PlatformService.getInstance();
const logger = SystemLogger.getInstance();

// Load Tauri APIs if available
if (platform.isTauri) {
  import('@tauri-apps/api/path').then(mod => { tauriHomeDir = mod.homeDir; });
  import('@tauri-apps/plugin-fs').then(mod => {
    tauriReadTextFile = mod.readTextFile;
    tauriWriteTextFile = mod.writeTextFile;
    tauriExists = mod.exists;
    tauriMkdir = mod.mkdir;
  });
}

/**
 * Verify Tauri filesystem APIs are loaded
 */
function requireTauriFs(): void {
  if (!tauriExists || !tauriMkdir || !tauriReadTextFile || !tauriWriteTextFile) {
    throw new Error('Tauri fs API not loaded');
  }
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
  if (!platform.isTauri) {
    throw new Error('File storage requires Tauri environment');
  }

  if (!tauriHomeDir) {
    throw new Error('Tauri path API not loaded');
  }

  const userNpub = getCurrentUserNpub();
  if (!userNpub) {
    throw new Error('File storage requires logged-in user');
  }

  const homePath = await tauriHomeDir();
  return `${homePath}/.noornote/${userNpub}/${filename}`;
}

/**
 * Ensure directory exists for file path
 */
export async function ensureDirectoryExists(filePath: string): Promise<void> {
  requireTauriFs();

  const dirPath = filePath.split('/').slice(0, -1).join('/');
  const dirExists = await tauriExists!(dirPath);

  if (!dirExists) {
    await tauriMkdir!(dirPath, { recursive: true });
    logger.info('file.ts', `Created directory: ${dirPath}`);
  }
}

/**
 * Read JSON data from file
 * Returns defaultData if file doesn't exist or on error
 */
export async function readJsonFile<T>(filename: string, defaultData: T): Promise<T> {
  try {
    const filePath = await getListFilePath(filename);
    requireTauriFs();

    const fileExists = await tauriExists!(filePath);
    if (!fileExists) {
      logger.info('file.ts', `File not found, using defaults: ${filename}`);
      return defaultData;
    }

    const content = await tauriReadTextFile!(filePath);
    const data: T = JSON.parse(content);

    logger.info('file.ts', `Read: ${filename}`);
    return data;
  } catch (error) {
    logger.error('file.ts', `Failed to read ${filename}: ${error}`);
    return defaultData;
  }
}

/**
 * Write JSON data to file
 */
export async function writeJsonFile<T>(filename: string, data: T): Promise<void> {
  try {
    const filePath = await getListFilePath(filename);
    requireTauriFs();

    await ensureDirectoryExists(filePath);
    await tauriWriteTextFile!(filePath, JSON.stringify(data, null, 2));

    logger.info('file.ts', `Wrote: ${filename}`);
  } catch (error) {
    logger.error('file.ts', `Failed to write ${filename}: ${error}`);
    throw error;
  }
}

/**
 * Check if file exists
 */
export async function fileExists(filename: string): Promise<boolean> {
  try {
    const filePath = await getListFilePath(filename);
    requireTauriFs();

    return await tauriExists!(filePath);
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
 * Used in Web/Mobile mode as alternative to Tauri file writing
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
  return new Promise((resolve) => {
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
        logger.error('file.ts', `Failed to parse uploaded file: ${error}`);
        resolve(null);
      }
    };

    input.oncancel = () => resolve(null);
    input.click();
  });
}
