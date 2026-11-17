/**
 * Follower Notification addon runtime.
 *
 * Heavy modules (the service, which pulls in the detector + scheduler) are statically imported
 * here so rollup splits them into this addon's chunk — loaded only when the addon is enabled.
 */

import type { AddonContext, AddonRuntime } from '../AddonLoader';
import type { FollowerNotificationService as Service } from './FollowerNotificationService';

export class FollowerNotificationRuntime implements AddonRuntime {
  public service: Service | null = null;

  async init(_ctx: AddonContext): Promise<void> {
    if (this.service) return; // idempotent
    // TEMP debug (user-requested): observe on-demand load/unload in console.
    const { FollowerNotificationService } = await import(
      './FollowerNotificationService'
    );
    this.service = FollowerNotificationService.getInstance();
    await this.service.start();
  }

  async destroy(): Promise<void> {
    if (!this.service) return; // idempotent
    this.service.destroy();
    this.service = null;
    // TEMP debug (user-requested): observe on-demand load/unload in console.
  }
}

export default new FollowerNotificationRuntime();
