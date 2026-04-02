/**
 * BaseFileStorage
 * Abstract base class for file-based storage
 *
 * Provides common functionality for storing data in ~/.noornote/{npub}/ directory.
 * Uses Electron (window.electronAPI) backend.
 *
 * Usage: Extend this class and implement abstract methods
 */

import { SystemLogger } from '../components/system/SystemLogger';
import { PlatformService } from './PlatformService';
import { AuthService } from './AuthService';

const platform = PlatformService.getInstance();

// ── Platform-agnostic FS wrappers ──

async function platformHomeDir(): Promise<string> {
  if (platform.isElectron) return window.electronAPI!.getHomeDir();
  throw new Error('Platform API not available for homeDir');
}

async function platformReadTextFile(filePath: string): Promise<string> {
  if (platform.isElectron) return window.electronAPI!.readTextFile(filePath);
  throw new Error('Platform API not available for readTextFile');
}

async function platformWriteTextFile(filePath: string, contents: string): Promise<void> {
  if (platform.isElectron) return window.electronAPI!.writeTextFile(filePath, contents);
  throw new Error('Platform API not available for writeTextFile');
}

async function platformExists(filePath: string): Promise<boolean> {
  if (platform.isElectron) return window.electronAPI!.fsExists(filePath);
  throw new Error('Platform API not available for exists');
}

async function platformMkdir(dirPath: string): Promise<void> {
  if (platform.isElectron) return window.electronAPI!.fsMkdir(dirPath);
  throw new Error('Platform API not available for mkdir');
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

    if (!platform.isDesktop) {
      throw new Error(`${this.getLoggerName()} requires desktop environment`);
    }

    const userNpub = this.getCurrentUserNpub();
    if (!userNpub) {
      throw new Error(`${this.getLoggerName()} requires logged-in user`);
    }

    try {
      const homePath = await platformHomeDir();
      const userDir = `${homePath}/.noornote/${userNpub}`;

      const dirExists = await platformExists(userDir);
      if (!dirExists) {
        await platformMkdir(userDir);
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
    if (!this.filePath) {
      throw new Error('File system not initialized');
    }

    const fileExists = await platformExists(this.filePath);
    if (!fileExists) {
      this.systemLogger.info(this.getLoggerName(), `Creating ${this.getFileName()} with defaults`);
      await platformWriteTextFile(this.filePath, JSON.stringify(this.getDefaultData(), null, 2));
    }
  }

  public async read(): Promise<T> {
    if (!this.fileInitialized || this.userContextChanged()) {
      await this.initialize();
    }

    if (!this.filePath) {
      throw new Error('File system not initialized');
    }

    try {
      const content = await platformReadTextFile(this.filePath);
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

    if (!this.filePath) {
      throw new Error('File system not initialized');
    }

    try {
      data.lastModified = Math.floor(Date.now() / 1000);
      await platformWriteTextFile(this.filePath, JSON.stringify(data, null, 2));
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
