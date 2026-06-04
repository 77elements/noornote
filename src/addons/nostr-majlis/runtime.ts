/**
 * nostr-majlis addon runtime (AddonLoader lifecycle).
 *
 * Owns DiyanetService (official Diyanet prayer times, fetched at runtime). The reminder
 * scheduler (AlertBar in-app + native local-notifications on mobile) lands in S3/S4 and
 * will live here so its timers/listeners are cleaned up by destroy().
 */

import type { AddonContext, AddonRuntime } from '../AddonLoader';
import { diagLog } from '../../services/DiagnosticLogger';
import { DiyanetService } from './DiyanetService';

export class NostrMajlisRuntime implements AddonRuntime {
  private initialized = false;

  async init(ctx: AddonContext): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    DiyanetService.getInstance();
    diagLog('addons', 'nostr-majlis: runtime init', { npub: ctx.npub?.slice(0, 12) });
  }

  async destroy(): Promise<void> {
    if (!this.initialized) return;
    this.initialized = false;
    DiyanetService.getInstance().destroy();
    diagLog('addons', 'nostr-majlis: runtime destroy');
  }
}

export default new NostrMajlisRuntime();
