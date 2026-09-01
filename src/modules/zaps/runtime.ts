import type { ModuleRuntime, ModuleContext } from '../../core/ModuleLoader';
import type { ZapsModuleApi, ZapResult } from './contracts';

export class ZapsRuntime implements ModuleRuntime<ZapsModuleApi> {
  private service: import('../../services/ZapService').ZapService | null = null;

  async init(_ctx: ModuleContext): Promise<void> {
    const { ZapService } = await import('../../services/ZapService');
    this.service = ZapService.getInstance();
  }

  async destroy(): Promise<void> {
    this.service = null;
  }

  getApi(): ZapsModuleApi {
    const svc = this.service;
    const noop: ZapResult = { success: false, error: 'Module not loaded' };
    return {
      sendQuickZap: (noteId, authorPubkey, articleEventId) =>
        svc?.sendQuickZap(noteId, authorPubkey, articleEventId) ??
        Promise.resolve(noop),
      sendCustomZap: (
        noteId,
        authorPubkey,
        amount,
        comment,
        articleEventId,
        anonymous
      ) =>
        svc?.sendCustomZap(
          noteId,
          authorPubkey,
          amount,
          comment,
          articleEventId,
          anonymous
        ) ?? Promise.resolve(noop),
      isOwnAnonZapInvoice: invoice =>
        svc?.isOwnAnonZapInvoice(invoice) ?? false,
      getUserZapAmount: noteId => svc?.getUserZapAmount(noteId) ?? 0,
      hasUserZapped: noteId => svc?.hasUserZapped(noteId) ?? false,
      getZapPendingStates: noteId => svc?.getZapPendingStates(noteId) ?? [],
      getUnconfirmedZapAmount: noteId =>
        svc?.getUnconfirmedZapAmount(noteId) ?? 0,
      reconcileZapStates: (noteId, zapEvents) =>
        svc?.reconcileZapStates(noteId, zapEvents),
    };
  }
}

export default new ZapsRuntime();
