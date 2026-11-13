import type { ModuleRuntime, ModuleContext } from '../../core/ModuleLoader';
import type { SingleNoteModuleApi } from './contracts';
import { NoteService } from '../../services/NoteService';

export class SingleNoteRuntime implements ModuleRuntime<SingleNoteModuleApi> {
  private orchestrator:
    | import('../../services/orchestration/ThreadOrchestrator').ThreadOrchestrator
    | null = null;
  private parentNoteFetcher:
    | import('../../services/ParentNoteFetcher').ParentNoteFetcher
    | null = null;
  private pollVoteService:
    | import('../../services/PollVoteService').PollVoteService
    | null = null;
  private quoteOrchestrator:
    | import('../../services/orchestration/QuoteOrchestrator').QuoteOrchestrator
    | null = null;
  private pollOrchestrator:
    | import('../../services/orchestration/PollOrchestrator').PollOrchestrator
    | null = null;

  /**
   * Resolves once init() has wired the orchestrators. API methods await this
   * instead of falling back to empty results when a consumer mounts BEFORE
   * the runtime finished loading its heavy modules — early mounts used to get
   * a silently empty parent chain / reply list with no retry (thread context
   * never appeared on fast deep-link loads).
   */
  private ready: Promise<void> = Promise.resolve();

  async init(_ctx: ModuleContext): Promise<void> {
    this.ready = (async () => {
      const [orchMod, parentMod, pollMod, quoteMod, pollOrchMod] =
        await Promise.all([
          import('../../services/orchestration/ThreadOrchestrator'),
          import('../../services/ParentNoteFetcher'),
          import('../../services/PollVoteService'),
          import('../../services/orchestration/QuoteOrchestrator'),
          import('../../services/orchestration/PollOrchestrator'),
        ]);
      this.orchestrator = orchMod.ThreadOrchestrator.getInstance();
      this.parentNoteFetcher = parentMod.ParentNoteFetcher.getInstance();
      this.pollVoteService = pollMod.PollVoteService.getInstance();
      this.quoteOrchestrator = quoteMod.QuoteOrchestrator.getInstance();
      this.pollOrchestrator = pollOrchMod.PollOrchestrator.getInstance();
    })();
    await this.ready;
  }

  async destroy(): Promise<void> {
    this.orchestrator = null;
    this.parentNoteFetcher = null;
    this.pollVoteService = null;
    this.quoteOrchestrator = null;
    this.pollOrchestrator = null;
  }

  getApi(): SingleNoteModuleApi {
    // Promise-based API methods await this.ready instead of silently
    // degrading when a consumer mounts BEFORE init()'s dynamic imports
    // resolved: early mounts used to get empty results with no retry at the
    // call sites (thread context / reply indicators stayed blank forever on
    // fast deep-link loads). Ready consumers behave identically — the await
    // resolves immediately once init() has run.
    return {
      getCachedNote: noteId => NoteService.getInstance().getCachedNote(noteId),
      cacheNote: event => NoteService.getInstance().registerNote(event),
      fetchReplies: (noteId, authorPubkey) =>
        this.ready.then(
          () => this.orchestrator?.fetchReplies(noteId, authorPubkey) ?? []
        ),
      fetchParentChain: noteId =>
        this.ready.then(
          () =>
            this.orchestrator?.fetchParentChain(noteId) ?? {
              root: null,
              parents: [],
              directParent: null,
              hasSkippedReplies: false,
            }
        ),
      startLiveReplies: (noteId, callback) =>
        this.orchestrator?.startLiveReplies(noteId, callback),
      stopLiveReplies: noteId => this.orchestrator?.stopLiveReplies(noteId),
      clearCache: noteId => this.orchestrator?.clearCache(noteId),
      waitForReplyOnRelays: (replyId, onConfirmed) =>
        this.ready.then(() =>
          this.orchestrator?.waitForReplyOnRelays(replyId, onConfirmed)
        ),
      fetchParentAuthor: (parentEventId, relayHint) =>
        this.ready.then(
          () =>
            this.parentNoteFetcher?.fetchParentAuthor(
              parentEventId,
              relayHint
            ) ?? null
        ),
      castVote: options =>
        this.ready.then(() => this.pollVoteService?.castVote(options) ?? false),
      fetchQuotedEvent: (nostrRef, authorHint, extraOutboundPubkeys) =>
        this.ready.then(
          () =>
            this.quoteOrchestrator?.fetchQuotedEvent(
              nostrRef,
              authorHint,
              extraOutboundPubkeys
            ) ?? null
        ),
      fetchPollResults: (pollEventId, pollOptions, currentUserPubkey) =>
        this.ready.then(
          () =>
            this.pollOrchestrator?.fetchPollResults(
              pollEventId,
              pollOptions,
              currentUserPubkey
            ) ?? {
              options: [],
              totalVotes: 0,
              userVote: null,
              timestamp: Date.now(),
            }
        ),
      clearPollCache: pollEventId =>
        this.ready.then(() => this.pollOrchestrator?.clearCache(pollEventId)),
    };
  }
}

export default new SingleNoteRuntime();
