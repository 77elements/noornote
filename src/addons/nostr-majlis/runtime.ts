/**
 * nostr-majlis addon runtime (AddonLoader lifecycle).
 *
 * S1: owns SalahService (the local prayer-time calculator). There is no background work
 * yet - times are computed on demand by the settings view. The reminder scheduler
 * (AlertBar in-app + native local-notifications on mobile) lands in S3/S4 and will live
 * here so its timers/listeners are cleaned up by destroy().
 *
 * Heavy imports (adhan via SalahService) are statically imported here so rollup keeps
 * them in this addon's chunk, out of the main bundle.
 */

import type { AddonContext, AddonRuntime } from '../AddonLoader';
import { diagLog } from '../../services/DiagnosticLogger';
import { SalahService } from './SalahService';

export class NostrMajlisRuntime implements AddonRuntime {
  private initialized = false;

  async init(ctx: AddonContext): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    SalahService.getInstance();
    diagLog('addons', 'nostr-majlis: runtime init', { npub: ctx.npub?.slice(0, 12) });
  }

  async destroy(): Promise<void> {
    if (!this.initialized) return;
    this.initialized = false;
    SalahService.getInstance().destroy();
    diagLog('addons', 'nostr-majlis: runtime destroy');
  }
}

export default new NostrMajlisRuntime();
