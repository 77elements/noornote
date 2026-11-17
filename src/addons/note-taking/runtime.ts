/**
 * Note taking runtime - AddonLoader lifecycle owner.
 *
 * Loaded on login (when enabled) / toggle-ON; destroyed on logout / account
 * switch / toggle-OFF. Heavy modules (NoteTakingStore, NoteTakingService, NoteTakingSyncService)
 * are statically imported ONLY here so rollup splits them into this chunk.
 *
 * Warms NoteTakingService (opens the per-user store) on init. NoteTakingSyncService's
 * initial relay sync is added in phase 1d.
 */

import type { AddonContext, AddonRuntime } from '../AddonLoader';
import { diagLog } from '../../services/DiagnosticLogger';
import { NoteTakingService } from './NoteTakingService';
import { NoteTakingSyncService } from './NoteTakingSyncService';
import { NoteTakingReminderService } from './NoteTakingReminderService';

export class NoteTakingRuntime implements AddonRuntime {
  private initialized = false;

  async init(ctx: AddonContext): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    // TEMP debug (user-requested): observe on-demand load/unload in console.
    // eslint-disable-next-line no-console -- TEMP, remove before release
    console.log('Note taking: on'); // console-ok: TEMP user-requested lifecycle trace
    await NoteTakingService.getInstance().init();
    // Registers the publish-on-change hook + runs the initial relay sync.
    void NoteTakingSyncService.getInstance().start();
    // Local reminder scheduler (fires a persistent alert toast when a reminder is due).
    NoteTakingReminderService.getInstance().start();
    diagLog('system', 'note-taking: runtime init', {
      npub: ctx.npub?.slice(0, 12),
    });
  }

  async destroy(): Promise<void> {
    if (!this.initialized) return;
    this.initialized = false;
    NoteTakingReminderService.getInstance().destroy();
    NoteTakingSyncService.getInstance().destroy();
    NoteTakingService.getInstance().destroy();
    diagLog('system', 'note-taking: runtime destroy');
    // TEMP debug (user-requested): observe on-demand load/unload in console.
    // eslint-disable-next-line no-console -- TEMP, remove before release
    console.log('Note taking: off'); // console-ok: TEMP user-requested lifecycle trace
  }
}

export default new NoteTakingRuntime();
