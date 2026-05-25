/**
 * MutualChangeService
 * Self-initializing service for mutual change detection (Phase 2-4)
 *
 * Architecture:
 * - Listens to user:login / user:logout via EventBus
 * - Delayed start: 3 minutes after login
 * - Stops on logout
 * - Completely decoupled from App.ts
 *
 * @purpose Orchestrate mutual change detection lifecycle
 * @used-by Automatically initializes on import
 */

import { EventBus } from './EventBus';
import { MutualChangeStorage } from '../lists/MutualChangeStorage';
import { MutualChangeScheduler } from './MutualChangeScheduler';
import { MutualChangeDetector } from './MutualChangeDetector';
import { SystemLogger } from './SystemLogger';

const DELAYED_START_MS = 3 * 60 * 1000; // 3 minutes

class MutualChangeServiceImpl {
  private eventBus: EventBus;
  private storage: MutualChangeStorage;
  private scheduler: MutualChangeScheduler;
  private detector: MutualChangeDetector;
  private systemLogger: SystemLogger;
  private delayedStartTimeout: ReturnType<typeof setTimeout> | null = null;
  private isInitialized: boolean = false;

  constructor() {
    this.eventBus = EventBus.getInstance();
    this.storage = MutualChangeStorage.getInstance();
    this.scheduler = MutualChangeScheduler.getInstance();
    this.detector = MutualChangeDetector.getInstance();
    this.systemLogger = SystemLogger.getInstance();

    this.setupEventListeners();
    this.systemLogger.info('MutualChangeService', 'Service initialized, waiting for login...');
  }

  private setupEventListeners(): void {
    // Start on login (with delay)
    this.eventBus.on('user:login', () => {
      this.handleLogin();
    });

    // Stop on logout
    this.eventBus.on('user:logout', () => {
      this.handleLogout();
    });
  }

  private async handleLogin(): Promise<void> {
    // Cancel any pending delayed start
    if (this.delayedStartTimeout) {
      clearTimeout(this.delayedStartTimeout);
    }

    this.systemLogger.info('MutualChangeService', 'User logged in, initializing storage immediately...');

    // Initialize storage from file IMMEDIATELY (so manual checks work)
    try {
      await this.storage.initFromFile();
      this.systemLogger.info('MutualChangeService', 'Storage initialized from file');
    } catch (error) {
      this.systemLogger.error('MutualChangeService', `Failed to init storage: ${error}`);
    }

    this.systemLogger.info('MutualChangeService', `Scheduling scheduler start in ${DELAYED_START_MS / 1000 / 60} minutes...`);

    // Delayed scheduler start to avoid impacting startup performance
    this.delayedStartTimeout = setTimeout(async () => {
      await this.startScheduler();
    }, DELAYED_START_MS);
  }

  private handleLogout(): void {
    // Cancel pending delayed start
    if (this.delayedStartTimeout) {
      clearTimeout(this.delayedStartTimeout);
      this.delayedStartTimeout = null;
    }

    // Stop scheduler
    this.scheduler.stop();

    // Clear localStorage cache
    this.storage.clearLocalStorage();

    this.isInitialized = false;
    this.systemLogger.info('MutualChangeService', 'Stopped on logout');
  }

  private async startScheduler(): Promise<void> {
    if (this.isInitialized) {
      this.systemLogger.info('MutualChangeService', 'Scheduler already started, skipping');
      return;
    }

    try {
      // Restore notifications from stored changes (survives app restart)
      // Note: Storage is already initialized from handleLogin()
      await this.detector.restoreNotificationsFromChanges();

      // Start scheduler
      // DISABLED: Too many false positives - see docs/todos/bugs.md
      // await this.scheduler.start();

      this.isInitialized = true;
      this.systemLogger.info('MutualChangeService', 'Scheduler DISABLED (false positives bug)');
    } catch (error) {
      this.systemLogger.error('MutualChangeService', `Failed to start scheduler: ${error}`);
    }
  }
}

// Auto-initialize singleton on import
export const MutualChangeService = new MutualChangeServiceImpl();
