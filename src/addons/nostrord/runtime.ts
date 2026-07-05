/**
 * Nostrord addon runtime.
 *
 * Watches the NIP-29 groups the user belongs to (their kind:10009 list) and raises a single
 * in-app notification per group whenever there was new activity within a poll window. Heavy
 * modules (the service, which pulls in an isolated NDK instance for the group relays) are
 * imported here so rollup splits them into this addon's own chunk, loaded only when enabled.
 */

import type { AddonContext, AddonRuntime } from '../AddonLoader';
import type { NostrordService as Service } from './NostrordService';

export class NostrordRuntime implements AddonRuntime {
  public service: Service | null = null;

  async init(_ctx: AddonContext): Promise<void> {
    if (this.service) return; // idempotent
    const { NostrordService } = await import('./NostrordService');
    this.service = NostrordService.getInstance();
    await this.service.start();
  }

  async destroy(): Promise<void> {
    if (!this.service) return; // idempotent
    this.service.destroy();
    this.service = null;
  }
}

export default new NostrordRuntime();
