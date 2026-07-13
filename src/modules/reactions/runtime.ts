import type { ModuleRuntime, ModuleContext } from '../../core/ModuleLoader';
import type { ReactionsModuleApi, InteractionStats } from './contracts';

export class ReactionsRuntime implements ModuleRuntime<ReactionsModuleApi> {
  private orchestrator: import('../../services/orchestration/ReactionsOrchestrator').ReactionsOrchestrator | null = null;
  private reactionService: import('../../services/ReactionService').ReactionService | null = null;
  private statsUpdateService: import('../../services/StatsUpdateService').StatsUpdateService | null = null;

  async init(_ctx: ModuleContext): Promise<void> {
    const [reactMod, reacSvcMod, statsMod] = await Promise.all([
      import('../../services/orchestration/ReactionsOrchestrator'),
      import('../../services/ReactionService'),
      import('../../services/StatsUpdateService'),
    ]);
    this.orchestrator = reactMod.ReactionsOrchestrator.getInstance();
    this.reactionService = reacSvcMod.ReactionService.getInstance();
    this.statsUpdateService = statsMod.StatsUpdateService.getInstance();
  }

  async destroy(): Promise<void> {
    this.orchestrator = null;
    this.reactionService = null;
    this.statsUpdateService = null;
  }

  getApi(): ReactionsModuleApi {
    const orch = this.orchestrator;
    const svc = this.reactionService;
    const sus = this.statsUpdateService;
    const emptyStats: InteractionStats = { likes: 0, reposts: 0, quotedReposts: 0, zaps: 0, replies: 0, lastUpdated: 0 };
    return {
      getStats: (noteId, authorPubkey, eventId) => orch?.getStats(noteId, authorPubkey, eventId) ?? Promise.resolve(emptyStats),
      batchFetchStats: (noteIds) => orch?.batchFetchStats(noteIds) ?? Promise.resolve(new Map()),
      getCachedStats: (noteId) => orch?.getCachedStats(noteId) ?? null,
      getDetailedStats: (noteId, eventId) => orch?.getDetailedStats(noteId, eventId) ?? Promise.resolve({ replyEvents: [], repostEvents: [], quotedEvents: [], reactionEvents: [], zapEvents: [], totalZapAmount: 0 } as any),
      updateCachedStats: (noteId, updates) => orch?.updateCachedStats(noteId, updates),
      clearCache: (noteId) => orch?.clearCache(noteId),
      startLiveReactions: (noteId, callback, options) => orch?.startLiveReactions(noteId, callback, options),
      stopLiveReactions: (noteId) => orch?.stopLiveReactions(noteId),
      resetFetchCounter: () => orch?.resetFetchCounter(),
      hasUserLiked: (noteId) => svc?.hasUserLiked(noteId) ?? Promise.resolve(false),
      hasUserLikedWithEmoji: (noteId, emoji) => svc?.hasUserLikedWithEmoji(noteId, emoji) ?? Promise.resolve(false),
      publishReaction: (options) => svc?.publishReaction(options) ?? Promise.resolve({ success: false, error: 'Module not loaded' }),
      fetchReactionTree: (rootEventIds) => orch?.fetchReactionTree(rootEventIds) ?? Promise.resolve(new Map()),
      getZapReplyCounts: (zapIds) => orch?.getZapReplyCounts(zapIds) ?? Promise.resolve(new Map()),
      updateAfterInteraction: (noteId, type, islComponent) => sus?.updateAfterInteraction(noteId, type, islComponent),
      clearCacheOnly: (noteId) => sus?.clearCacheOnly(noteId),
    };
  }
}

export default new ReactionsRuntime();
