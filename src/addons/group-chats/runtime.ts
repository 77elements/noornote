/**
 * GroupChats addon runtime — hosts both the Nostrord (NIP-29) notifier
 * and the Armada (Concord) notifier under the same "Group Chats" umbrella.
 *
 * Heavy modules (the services, which pull in isolated NDK instances for the
 * group relays) are imported here so rollup splits them into this addon's
 * own chunk, loaded only when enabled.
 *
 * Lifecycle:
 *   - GroupChatsService always starts when the addon is enabled (it has its
 *     own internal toggle check for NIP-29 specifically).
 *   - ArmadaService starts only when the Armada sub-toggle is ON.
 *   - On destroy (logout / account switch / toggle OFF): both services are
 *     torn down, their singletons nulled, all timers cleared.
 */

import type { AddonContext, AddonRuntime } from '../AddonLoader';
import type { GroupChatsService as Service } from './GroupChatsService';
import type { ArmadaService as ArmSvc } from './armada/ArmadaService';
import { isArmadaEnabled } from './index';

export class GroupChatsRuntime implements AddonRuntime {
  public service: Service | null = null;
  public armadaService: ArmSvc | null = null;

  async init(_ctx: AddonContext): Promise<void> {
    if (this.service) return; // idempotent

    // GroupChatsService (NIP-29 / Nostrord notifier)
    const { GroupChatsService } = await import('./GroupChatsService');
    this.service = GroupChatsService.getInstance();
    await this.service.start();

    // ArmadaService (Concord encrypted-community notifier)
    // Only starts when the Armada sub-toggle is ON.
    if (isArmadaEnabled()) {
      const { ArmadaService } = await import('./armada/ArmadaService');
      this.armadaService = ArmadaService.getInstance();
      await this.armadaService.start();
    }
  }

  async destroy(): Promise<void> {
    if (this.service) {
      this.service.destroy();
      this.service = null;
    }
    if (this.armadaService) {
      this.armadaService.destroy();
      this.armadaService = null;
    }
  }
}

export default new GroupChatsRuntime();
