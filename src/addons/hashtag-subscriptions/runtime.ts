/**
 * Hashtag Subscriptions addon runtime.
 *
 * Loaded by AddonLoader when the flag is ON. Owns the polling lifecycle
 * of HashtagNotificationService: starts the 1-minute-initial +
 * 5-minute-periodic poller on init, stops everything on destroy.
 *
 * Destroy contract:
 *   - HashtagNotificationService.destroy() clears both timers
 *     (initialPollTimeout + pollInterval) and releases the static
 *     singleton reference. No long-lived EventBus subscriptions exist —
 *     the service only emits, never subscribes.
 *   - runtime nullifies its own reference so GC can reclaim the
 *     service instance.
 */

import type { AddonContext, AddonRuntime } from '../AddonLoader';
import type { HashtagNotificationService as Service } from './HashtagNotificationService';

export class HashtagSubscriptionsRuntime implements AddonRuntime {
  public service: Service | null = null;

  async init(_ctx: AddonContext): Promise<void> {
    if (this.service) return;
    const { HashtagNotificationService } = await import(
      './HashtagNotificationService'
    );
    this.service = HashtagNotificationService.getInstance();
    this.service.startPolling();
  }

  async destroy(): Promise<void> {
    if (!this.service) return;
    this.service.destroy();
    this.service = null;
  }
}

export default new HashtagSubscriptionsRuntime();
