/**
 * BaseFileStorage
 * Abstract base class for file-based storage using Tauri FS API
 *
 * Provides common functionality for storing data in ~/.noornote/{npub}/ directory:
 * - Per-user file paths (each user has their own directory)
 * - Tauri environment detection
 * - Dynamic Tauri API imports
 * - Directory creation
 * - File initialization
 * - JSON read/write with error handling
 *
 * Usage: Extend this class and implement abstract methods
 */

import { SystemLogger } from '../components/system/SystemLogger';
import { PlatformService } from './PlatformService';
import { AuthService } from './AuthService';

// Tauri APIs (dynamically imported to support browser builds)
let tauriHomeDir: typeof import('@tauri-apps/api/path').homeDir | null = null;
let tauriReadTextFile: typeof import('@tauri-apps/plugin-fs').readTextFile | null = null;
let tauriWriteTextFile: typeof import('@tauri-apps/plugin-fs').writeTextFile | null = null;
let tauriExists: typeof import('@tauri-apps/plugin-fs').exists | null = null;
let tauriMkdir: typeof import('@tauri-apps/plugin-fs').mkdir | null = null;

const platform = PlatformService.getInstance();

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
 * Base interface for all file storage data
 */
export interface BaseFileData {
  lastModified: number;
  lastPublishedEventId?: string;
}

/**
 * Abstract base class for file storage
 */
export abstract class BaseFileStorage<T extends BaseFileData> {
  protected systemLogger: SystemLogger;
  protected filePath: string | null = null;
  protected fileInitialized: boolean = false;
  protected currentUserNpub: string | null = null;

  constructor() {
    this.systemLogger = SystemLogger.getInstance();
  }

  protected getCurrentUserNpub(): string | null {
    const user = AuthService.getInstance().getCurrentUser();
    return user?.npub ?? null;
  }

  protected userContextChanged(): boolean {
    return this.getCurrentUserNpub() !== this.currentUserNpub;
  }

  protected resetInitialization(): void {
    this.filePath = null;
    this.fileInitialized = false;
    this.currentUserNpub = null;
  }

  protected abstract getFileName(): string;
  protected abstract getDefaultData(): T;
  protected abstract getLoggerName(): string;

  protected migrateData(data: T): T {
    return data;
  }

  public async initialize(): Promise<void> {
    if (this.fileInitialized && this.userContextChanged()) {
      this.systemLogger.info(this.getLoggerName(), 'User context changed, reinitializing...');
      this.resetInitialization();
    }

    if (this.fileInitialized) return;

    if (!platform.isTauri) {
      throw new Error(`${this.getLoggerName()} requires Tauri environment`);
    }

    if (!tauriHomeDir || !tauriMkdir) {
      throw new Error('Tauri path API not loaded');
    }

    const userNpub = this.getCurrentUserNpub();
    if (!userNpub) {
      throw new Error(`${this.getLoggerName()} requires logged-in user`);
    }

    try {
      const homePath = await tauriHomeDir();
      const userDir = `${homePath}/.noornote/${userNpub}`;

      if (!tauriExists) {
        throw new Error('Tauri fs API not loaded');
      }

      const dirExists = await tauriExists(userDir);
      if (!dirExists) {
        await tauriMkdir(userDir, { recursive: true });
        this.systemLogger.info(this.getLoggerName(), `Created user directory: ${userDir}`);
      }

      this.filePath = `${userDir}/${this.getFileName()}`;
      this.currentUserNpub = userNpub;
      this.fileInitialized = true;

      this.systemLogger.info(this.getLoggerName(), `Initialized: ${this.filePath}`);

      await this.ensureFileExists();
    } catch (error) {
      this.systemLogger.error(this.getLoggerName(), `Failed to initialize: ${error}`);
      throw error;
    }
  }

  protected async ensureFileExists(): Promise<void> {
    if (!this.filePath || !tauriExists || !tauriWriteTextFile) {
      throw new Error('File system not initialized');
    }

    const fileExists = await tauriExists(this.filePath);
    if (!fileExists) {
      this.systemLogger.info(this.getLoggerName(), `Creating ${this.getFileName()} with defaults`);
      await tauriWriteTextFile(this.filePath, JSON.stringify(this.getDefaultData(), null, 2));
    }
  }

  public async read(): Promise<T> {
    if (!this.fileInitialized || this.userContextChanged()) {
      await this.initialize();
    }

    if (!this.filePath || !tauriReadTextFile) {
      throw new Error('File system not initialized');
    }

    try {
      const content = await tauriReadTextFile(this.filePath);
      const rawData: T = JSON.parse(content);
      const data = this.migrateData(rawData);
      this.systemLogger.info(this.getLoggerName(), `Read data from ${this.getFileName()}`);
      return data;
    } catch (error) {
      this.systemLogger.error(this.getLoggerName(), `Failed to read data: ${error}`);
      return this.getDefaultData();
    }
  }

  public async write(data: T): Promise<void> {
    if (!this.fileInitialized || this.userContextChanged()) {
      await this.initialize();
    }

    if (!this.filePath || !tauriWriteTextFile) {
      throw new Error('File system not initialized');
    }

    try {
      data.lastModified = Math.floor(Date.now() / 1000);
      await tauriWriteTextFile(this.filePath, JSON.stringify(data, null, 2));
      this.systemLogger.info(this.getLoggerName(), `Wrote data to ${this.getFileName()}`);
    } catch (error) {
      this.systemLogger.error(this.getLoggerName(), `Failed to write data: ${error}`);
      throw error;
    }
  }

  public getFilePath(): string | null {
    return this.filePath;
  }
}
