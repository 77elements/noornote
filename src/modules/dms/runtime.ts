import type { ModuleRuntime, ModuleContext } from '../../core/ModuleLoader';
import type { DMsModuleApi } from './contracts';

/**
 * DMs module runtime — thin wrapper around DMService singleton.
 *
 * Does NOT call start() — PostLoginService handles that.
 * See notifications/runtime.ts for the race-condition rationale.
 */
export class DMsRuntime implements ModuleRuntime<DMsModuleApi> {
  private service: import('../../services/dm/DMService').DMService | null = null;

  async init(_ctx: ModuleContext): Promise<void> {
    const { DMService } = await import('../../services/dm/DMService');
    this.service = DMService.getInstance();
  }

  async destroy(): Promise<void> {
    this.service = null;
  }

  getApi(): DMsModuleApi {
    const svc = this.service;
    return {
      getUnreadCount: () => svc?.getUnreadCount() ?? Promise.resolve(0),
      getUnreadCountsSplit: () => svc?.getUnreadCountsSplit() ?? Promise.resolve({ known: 0, unknown: 0, total: 0 }),
      refreshSubscriptions: () => svc?.refreshSubscriptions() ?? Promise.resolve(),
      sendMessage: (recipientPubkey, content, replyTo) => svc?.sendMessage(recipientPubkey, content, replyTo) ?? Promise.resolve(false),
      getConversations: (limit, offset) => svc?.getConversations(limit, offset) ?? Promise.resolve([]),
      getMessages: (partnerPubkey, limit, before) => svc?.getMessages(partnerPubkey, limit, before) ?? Promise.resolve([]),
      markAsRead: (partnerPubkey) => svc?.markAsRead(partnerPubkey) ?? Promise.resolve(),
      markAllAsRead: () => svc?.markAllAsRead() ?? Promise.resolve(),
      start: () => svc?.start() ?? Promise.resolve(),
      stop: () => svc?.stop(),
    };
  }
}

export default new DMsRuntime();
