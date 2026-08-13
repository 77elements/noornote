/**
 * Nostrord addon runtime — also hosts the Armada (Concord) notifier.
 *
 * Watches the NIP-29 groups the user belongs to (their kind:10009 list) and
 * raises a single in-app notification per group whenever there was new
 * activity within a poll window. Heavy modules (the service, which pulls in
 * an isolated NDK instance for the group relays) are imported here so
 * rollup splits them into this addon's own chunk, loaded only when enabled.
 *
 * Armada (Concord) notifications: Sprint 1 of the Armada rollout ships the
 * UI toggle only (see `docs/todos/armada-concord-groups-addon.md`). When the
 * toggle is ON, this runtime logs the opt-in via diagLog so we can see in
 * diagnostics that a user is waiting for the polling pipeline (Sprints 2–4)
 * to land. No `ArmadaService` exists yet — adding it later is a drop-in:
 * gate the import + start on `isArmadaEnabled()` (mirroring the Nostrord
 * branch below) and the existing `'armada-notification:new'` event handlers
 * in NotificationsOrchestrator pick up the emits with zero UI changes.
 */

import type { AddonContext, AddonRuntime } from '../AddonLoader';
import type { NostrordService as Service } from './NostrordService';
import { isArmadaEnabled } from './index';
import { diagLog } from '../../services/DiagnosticLogger';

export class NostrordRuntime implements AddonRuntime {
  public service: Service | null = null;

  async init(_ctx: AddonContext): Promise<void> {
    if (this.service) return; // idempotent
    const { NostrordService } = await import('./NostrordService');
    this.service = NostrordService.getInstance();
    await this.service.start();

    // Armada opt-in beacon. Sprint 1 status: UI toggle is live, polling is
    // NOT — this log line is the only runtime side-effect of enabling Armada
    // today. Sprints 2–4 will replace this block with a real ArmadaService
    // lifecycle, gated on the same flag.
    if (isArmadaEnabled()) {
      diagLog('addons', 'armada: opt-in active but polling not yet implemented (Sprint 1 scaffold)');
    }
  }

  async destroy(): Promise<void> {
    if (!this.service) return; // idempotent
    this.service.destroy();
    this.service = null;
  }
}

export default new NostrordRuntime();
