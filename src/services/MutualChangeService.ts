/**
 * MutualChangeService
 * Binds the MutualChangeStorage lifecycle to login/logout so the MANUAL "Check for Changes"
 * feature (Extended Follows) has its persisted snapshot ready, and clears the cache on account switch.
 *
 * The old AUTOMATIC background scheduler was removed on 2026-06-10 (flaky — too many false positives
 * from relay-coverage noise). See docs/features/mutual-check-feature-04-automation.md. Mutual change
 * detection is now on-demand only, triggered by the user via the "Check for Changes" button.
 *
 * @purpose Storage lifecycle for the manual mutual-change check
 * @used-by Auto-initializes on import (main.ts, only when the Extended Follows addon is enabled)
 */

import { TypedEventBus } from '../core/TypedEventBus';
import { MutualChangeStorage } from '../lists/MutualChangeStorage';
import { SystemLogger } from './SystemLogger';

class MutualChangeServiceImpl {
  private eventBus: TypedEventBus;
  private storage: MutualChangeStorage;
  private systemLogger: SystemLogger;

  constructor() {
    this.eventBus = TypedEventBus.getInstance();
    this.storage = MutualChangeStorage.getInstance();
    this.systemLogger = SystemLogger.getInstance();

    this.eventBus.on('user:login', () => {
      void this.handleLogin();
    });
    this.eventBus.on('user:logout', () => {
      this.handleLogout();
    });
    this.systemLogger.info(
      'MutualChangeService',
      'Service initialized, waiting for login...'
    );
  }

  /** Load the persisted snapshot so the manual "Check for Changes" can diff against it. */
  private async handleLogin(): Promise<void> {
    try {
      await this.storage.initFromFile();
      this.systemLogger.info(
        'MutualChangeService',
        'Storage initialized from file'
      );
    } catch (error) {
      this.systemLogger.error(
        'MutualChangeService',
        `Failed to init storage: ${String(error)}`
      );
    }
  }

  private handleLogout(): void {
    this.storage.clearLocalStorage();
    this.systemLogger.info(
      'MutualChangeService',
      'Storage cache cleared on logout'
    );
  }
}

// Auto-initialize singleton on import
export const MutualChangeService = new MutualChangeServiceImpl();
