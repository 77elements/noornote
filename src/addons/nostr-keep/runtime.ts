/**
 * Nostr Keep runtime — AddonLoader lifecycle owner.
 *
 * Loaded on login (when enabled) / toggle-ON; destroyed on logout / account
 * switch / toggle-OFF. Heavy modules (KeepStore, KeepService, KeepSyncService)
 * are statically imported ONLY here so rollup splits them into this chunk.
 *
 * Warms KeepService (opens the per-user store) on init. KeepSyncService's
 * initial relay sync is added in phase 1d.
 */

import type { AddonContext, AddonRuntime } from '../AddonLoader';
import { diagLog } from '../../services/DiagnosticLogger';
import { KeepService } from './KeepService';
import { KeepSyncService } from './KeepSyncService';

export class NostrKeepRuntime implements AddonRuntime {
  private initialized = false;

  async init(ctx: AddonContext): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await KeepService.getInstance().init();
    // Registers the publish-on-change hook + runs the initial relay sync.
    void KeepSyncService.getInstance().start();
    diagLog('system', 'nostr-keep: runtime init', { npub: ctx.npub?.slice(0, 12) });
  }

  async destroy(): Promise<void> {
    if (!this.initialized) return;
    this.initialized = false;
    KeepSyncService.getInstance().destroy();
    KeepService.getInstance().destroy();
    diagLog('system', 'nostr-keep: runtime destroy');
  }
}

export default new NostrKeepRuntime();
