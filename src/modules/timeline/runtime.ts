import type { ModuleRuntime, ModuleContext } from '../../core/ModuleLoader';
import type { TimelineModuleApi } from './contracts';

export class TimelineRuntime implements ModuleRuntime<TimelineModuleApi> {
  private orchestrator: import('../../services/orchestration/FeedOrchestrator').FeedOrchestrator | null = null;

  async init(_ctx: ModuleContext): Promise<void> {
    const { FeedOrchestrator } = await import('../../services/orchestration/FeedOrchestrator');
    this.orchestrator = FeedOrchestrator.getInstance();
  }

  async destroy(): Promise<void> {
    this.orchestrator = null;
  }

  getApi(): TimelineModuleApi {
    const orch = this.orchestrator;
    const emptyResult = { events: [], hasMore: false };
    return {
      loadInitialFeed: (request) => orch?.loadInitialFeed(request) ?? Promise.resolve(emptyResult as any),
      loadMore: (request) => orch?.loadMore(request) ?? Promise.resolve(emptyResult as any),
      getLoadedNote: (eventId) => orch?.getLoadedNote(eventId) ?? null,
      hasLoadedNote: (eventId) => orch?.hasLoadedNote(eventId) ?? false,
      registerNotes: (events) => orch?.registerNotes(events),
      clearCache: () => orch?.clearCache(),
    };
  }
}

export default new TimelineRuntime();
