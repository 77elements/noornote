/**
 * nostr-majlis addon runtime (AddonLoader lifecycle).
 *
 * Owns DiyanetService (official prayer times, runtime-fetched + cached) and the in-app
 * reminder scheduler (AlertBar). Both are torn down by destroy() so timers/state never
 * leak across logout / account-switch / toggle-off. Native sleep-screen notifications
 * are S4. See docs/todos/muslims-addon.md.
 */

import type { AddonContext, AddonRuntime } from '../AddonLoader';
import { diagLog } from '../../services/DiagnosticLogger';
import { DiyanetService } from './DiyanetService';
import { NostrMajlisReminderService } from './NostrMajlisReminderService';

export class NostrMajlisRuntime implements AddonRuntime {
  private initialized = false;

  async init(ctx: AddonContext): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    DiyanetService.getInstance();
    NostrMajlisReminderService.getInstance().start();
    diagLog('addons', 'nostr-majlis: runtime init', { npub: ctx.npub?.slice(0, 12) });
  }

  async destroy(): Promise<void> {
    if (!this.initialized) return;
    this.initialized = false;
    NostrMajlisReminderService.getInstance().destroy();
    DiyanetService.getInstance().destroy();
    diagLog('addons', 'nostr-majlis: runtime destroy');
  }
}

export default new NostrMajlisRuntime();
