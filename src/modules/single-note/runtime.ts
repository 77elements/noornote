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

  async init(_ctx: ModuleContext): Promise<void> {
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
  }

  async destroy(): Promise<void> {
    this.orchestrator = null;
    this.parentNoteFetcher = null;
    this.pollVoteService = null;
    this.quoteOrchestrator = null;
    this.pollOrchestrator = null;
  }

  getApi(): SingleNoteModuleApi {
    const orch = this.orchestrator;
    const pnf = this.parentNoteFetcher;
    const pvs = this.pollVoteService;
    const qo = this.quoteOrchestrator;
    const po = this.pollOrchestrator;
    return {
      getCachedNote: noteId => NoteService.getInstance().getCachedNote(noteId),
      cacheNote: event => NoteService.getInstance().registerNote(event),
      fetchReplies: (noteId, authorPubkey) =>
        orch?.fetchReplies(noteId, authorPubkey) ?? Promise.resolve([]),
      fetchParentChain: noteId =>
        orch?.fetchParentChain(noteId) ??
        Promise.resolve({ items: [], rootId: null } as any),
      startLiveReplies: (noteId, callback) =>
        orch?.startLiveReplies(noteId, callback),
      stopLiveReplies: noteId => orch?.stopLiveReplies(noteId),
      clearCache: noteId => orch?.clearCache(noteId),
      fetchParentAuthor: (parentEventId, relayHint) =>
        pnf?.fetchParentAuthor(parentEventId, relayHint) ??
        Promise.resolve(null),
      castVote: options => pvs?.castVote(options) ?? Promise.resolve(false),
      fetchQuotedEvent: (nostrRef, authorHint, extraOutboundPubkeys) =>
        qo?.fetchQuotedEvent(nostrRef, authorHint, extraOutboundPubkeys) ??
        Promise.resolve(null),
      fetchPollResults: (pollEventId, pollOptions, currentUserPubkey) =>
        po?.fetchPollResults(pollEventId, pollOptions, currentUserPubkey) ??
        Promise.resolve({
          options: [],
          totalVotes: 0,
          userVote: null,
          timestamp: Date.now(),
        }),
      clearPollCache: pollEventId => po?.clearCache(pollEventId),
    };
  }
}

export default new SingleNoteRuntime();
