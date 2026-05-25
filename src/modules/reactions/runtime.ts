import type { ModuleRuntime, ModuleContext } from '../../core/ModuleLoader';
import type { ReactionsModuleApi, InteractionStats } from './contracts';

export class ReactionsRuntime implements ModuleRuntime<ReactionsModuleApi> {
  private orchestrator: import('../../services/orchestration/ReactionsOrchestrator').ReactionsOrchestrator | null = null;
  private reactionService: import('../../services/ReactionService').ReactionService | null = null;

  async init(_ctx: ModuleContext): Promise<void> {
    const { ReactionsOrchestrator } = await import('../../services/orchestration/ReactionsOrchestrator');
    const { ReactionService } = await import('../../services/ReactionService');
    this.orchestrator = ReactionsOrchestrator.getInstance();
    this.reactionService = ReactionService.getInstance();
  }

  async destroy(): Promise<void> {
    this.orchestrator = null;
    this.reactionService = null;
  }

  getApi(): ReactionsModuleApi {
    const orch = this.orchestrator;
    const svc = this.reactionService;
    const emptyStats: InteractionStats = { likes: 0, reposts: 0, quotedReposts: 0, zaps: 0, replies: 0, lastUpdated: 0 };
    return {
      getStats: (noteId, authorPubkey, eventId) => orch?.getStats(noteId, authorPubkey, eventId) ?? Promise.resolve(emptyStats),
      getCachedStats: (noteId) => orch?.getCachedStats(noteId) ?? null,
      getDetailedStats: (noteId, eventId) => orch?.getDetailedStats(noteId, eventId) ?? Promise.resolve({ replyEvents: [], repostEvents: [], quotedEvents: [], reactionEvents: [], zapEvents: [], totalZapAmount: 0 } as any),
      updateCachedStats: (noteId, updates) => orch?.updateCachedStats(noteId, updates),
      clearCache: (noteId) => orch?.clearCache(noteId),
      startLiveReactions: (noteId, callback, options) => orch?.startLiveReactions(noteId, callback, options),
      stopLiveReactions: (noteId) => orch?.stopLiveReactions(noteId),
      hasUserLiked: (noteId) => svc?.hasUserLiked(noteId) ?? Promise.resolve(false),
      publishReaction: (options) => svc?.publishReaction(options) ?? Promise.resolve({ success: false, error: 'Module not loaded' }),
    };
  }
}

export default new ReactionsRuntime();
