/**
 * readWriteJson - Low-Level File I/O Helper
 *
 * Zentrale Funktionen für JSON File-Operationen mit Tauri FS API.
 * Wird von BaseFileStorage, MutualCheckDebugLog und UserSettingsStorage verwendet.
 *
 * Features:
 * - Lazy-loading der Tauri APIs (vermeidet Race Conditions)
 * - Per-user Verzeichnisse (~/.noornote/{npub}/)
 * - Saubere Error-Handling
 *
 * @purpose Zentrale File I/O für alle Storage-Klassen
 */

import { PlatformService } from '../PlatformService';

// Type for Tauri API references
type TauriApis = {
  homeDir: typeof import('@tauri-apps/api/path').homeDir;
  readTextFile: typeof import('@tauri-apps/plugin-fs').readTextFile;
  writeTextFile: typeof import('@tauri-apps/plugin-fs').writeTextFile;
  exists: typeof import('@tauri-apps/plugin-fs').exists;
  mkdir: typeof import('@tauri-apps/plugin-fs').mkdir;
};

// Cached Tauri API references (lazy-loaded)
let tauriApis: TauriApis | null = null;

// Promise for loading (ensures we only load once)
let loadPromise: Promise<TauriApis> | null = null;

/**
 * Load Tauri APIs (lazy, cached)
 * Throws if not in Tauri environment
 */
async function ensureTauriApis(): Promise<TauriApis> {
  const platform = PlatformService.getInstance();

  if (!platform.isTauri) {
    throw new Error('File operations require Tauri environment');
  }

  // Return cached if already loaded
  if (tauriApis) {
    return tauriApis;
  }

  // Start loading if not already
  if (!loadPromise) {
    loadPromise = (async () => {
      const [pathMod, fsMod] = await Promise.all([
        import('@tauri-apps/api/path'),
        import('@tauri-apps/plugin-fs')
      ]);

      const apis = {
        homeDir: pathMod.homeDir,
        readTextFile: fsMod.readTextFile,
        writeTextFile: fsMod.writeTextFile,
        exists: fsMod.exists,
        mkdir: fsMod.mkdir
      };
      tauriApis = apis;

      return apis;
    })();
  }

  const result = await loadPromise;
  if (!result) {
    throw new Error('Failed to load Tauri APIs');
  }

  return result;
}

/**
 * Get home directory path
 */
export async function getHomeDir(): Promise<string> {
  const apis = await ensureTauriApis();
  return await apis.homeDir();
}

/**
 * Get user-specific directory path: ~/.noornote/{npub}/
 * Creates the directory if it doesn't exist
 */
export async function getUserDir(npub: string): Promise<string> {
  const apis = await ensureTauriApis();
  const homePath = await apis.homeDir();
  const userDir = `${homePath}/.noornote/${npub}`;

  // Ensure directory exists
  const dirExists = await apis.exists(userDir);
  if (!dirExists) {
    await apis.mkdir(userDir, { recursive: true });
  }

  return userDir;
}

/**
 * Check if file or directory exists
 */
export async function fileExists(path: string): Promise<boolean> {
  const apis = await ensureTauriApis();
  return await apis.exists(path);
}

/**
 * Ensure directory exists (creates recursively if needed)
 */
export async function ensureDir(path: string): Promise<void> {
  const apis = await ensureTauriApis();
  const dirExists = await apis.exists(path);
  if (!dirExists) {
    await apis.mkdir(path, { recursive: true });
  }
}

/**
 * Read JSON file
 * Returns null if file doesn't exist (not an error)
 * Throws on parse errors or other I/O errors
 */
export async function readJson<T>(path: string): Promise<T | null> {
  const apis = await ensureTauriApis();

  // Check if file exists first
  const exists = await apis.exists(path);
  if (!exists) {
    return null;
  }

  const content = await apis.readTextFile(path);
  return JSON.parse(content) as T;
}

/**
 * Write JSON file
 * Pretty-prints with 2-space indentation
 */
export async function writeJson<T>(path: string, data: T): Promise<void> {
  const apis = await ensureTauriApis();
  const content = JSON.stringify(data, null, 2);
  await apis.writeTextFile(path, content);
}

/**
 * Check if Tauri file operations are available
 * Use this for graceful degradation in browser mode
 */
export function isFileSystemAvailable(): boolean {
  return PlatformService.getInstance().isTauri;
}
