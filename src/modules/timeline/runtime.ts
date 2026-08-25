import type { ModuleRuntime, ModuleContext } from '../../core/ModuleLoader';
import type { TimelineModuleApi } from './contracts';

export class TimelineRuntime implements ModuleRuntime<TimelineModuleApi> {
  private orchestrator:
    | import('../../services/orchestration/FeedOrchestrator').FeedOrchestrator
    | null = null;

  async init(_ctx: ModuleContext): Promise<void> {
    const { FeedOrchestrator } = await import(
      '../../services/orchestration/FeedOrchestrator'
    );
    this.orchestrator = FeedOrchestrator.getInstance();
  }

  async destroy(): Promise<void> {
    this.orchestrator = null;
  }

  getApi(): TimelineModuleApi {
    const orch = this.orchestrator;
    const emptyResult = { events: [], hasMore: false };
    return {
      loadInitialFeed: request =>
        orch?.loadInitialFeed(request) ?? Promise.resolve(emptyResult as any),
      loadMore: request =>
        orch?.loadMore(request) ?? Promise.resolve(emptyResult as any),
      loadLatestPerAuthor: (pubkeys, includeReplies, applyWordFilter) =>
        orch?.loadLatestPerAuthor(pubkeys, includeReplies, applyWordFilter) ??
        Promise.resolve([]),
      getLoadedNote: eventId => orch?.getLoadedNote(eventId) ?? null,
      hasLoadedNote: eventId => orch?.hasLoadedNote(eventId) ?? false,
      registerNotes: events => orch?.registerNotes(events),
      clearCache: () => orch?.clearCache(),

      // Polling
      startPolling: (
        followingPubkeys,
        lastLoadedTimestamp,
        callback,
        includeReplies,
        delayMs,
        specificRelay,
        exemptFromMuteFilter,
        applyWordFilter
      ) =>
        orch?.startPolling(
          followingPubkeys,
          lastLoadedTimestamp,
          callback,
          includeReplies,
          delayMs ?? 10000,
          specificRelay ?? null,
          exemptFromMuteFilter,
          applyWordFilter ?? true
        ),
      stopPolling: () => orch?.stopPolling(),
      getPolledEvents: () => orch?.getPolledEvents() ?? [],
      resetPollingTimestamp: newTimestamp =>
        orch?.resetPollingTimestamp(newTimestamp),
      pollOnce: (
        followingPubkeys,
        newestTimestamp,
        includeReplies,
        specificRelay,
        exemptFromMuteFilter,
        applyWordFilter
      ) =>
        orch?.pollOnce(
          followingPubkeys,
          newestTimestamp,
          includeReplies,
          specificRelay,
          exemptFromMuteFilter,
          applyWordFilter
        ) ?? Promise.resolve([]),

      // Mute management
      refreshMutedUsers: () => orch?.refreshMutedUsers(),

      // Event metadata
      getEventRelays: eventId => orch?.getEventRelays(eventId) ?? [],
    };
  }
}

export default new TimelineRuntime();
