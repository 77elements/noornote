import type { ModuleRuntime, ModuleContext } from '../../core/ModuleLoader';
import type { PostsModuleApi } from './contracts';
import { BroadcastDeleteService } from '../../services/BroadcastDeleteService';

export class PostsRuntime implements ModuleRuntime<PostsModuleApi> {
  private service: import('../../services/PostService').PostService | null =
    null;
  private noteService: import('../../services/NoteService').NoteService | null =
    null;
  private repostService:
    | import('../../services/RepostService').RepostService
    | null = null;
  private deletionService:
    | import('../../services/DeletionService').DeletionService
    | null = null;
  private reportService:
    | import('../../services/ReportService').ReportService
    | null = null;
  private ReportServiceClass:
    | typeof import('../../services/ReportService').ReportService
    | null = null;
  private mentionCache:
    | import('../../services/MentionProfileCache').MentionProfileCache
    | null = null;
  private outboundRelays:
    | import('../../services/orchestration/OutboundRelaysOrchestrator').OutboundRelaysOrchestrator
    | null = null;

  async init(_ctx: ModuleContext): Promise<void> {
    const [
      postMod,
      noteMod,
      repostMod,
      deletionMod,
      reportMod,
      mentionMod,
      outboundMod,
    ] = await Promise.all([
      import('../../services/PostService'),
      import('../../services/NoteService'),
      import('../../services/RepostService'),
      import('../../services/DeletionService'),
      import('../../services/ReportService'),
      import('../../services/MentionProfileCache'),
      import('../../services/orchestration/OutboundRelaysOrchestrator'),
    ]);
    this.service = postMod.PostService.getInstance();
    this.noteService = noteMod.NoteService.getInstance();
    this.repostService = repostMod.RepostService.getInstance();
    this.deletionService = deletionMod.DeletionService.getInstance();
    this.reportService = reportMod.ReportService.getInstance();
    this.ReportServiceClass = reportMod.ReportService;
    this.mentionCache = mentionMod.MentionProfileCache.getInstance();
    this.outboundRelays = outboundMod.OutboundRelaysOrchestrator.getInstance();
  }

  async destroy(): Promise<void> {
    this.service = null;
    this.noteService = null;
    this.repostService = null;
    this.deletionService = null;
    this.reportService = null;
    this.ReportServiceClass = null;
    this.mentionCache = null;
    this.outboundRelays = null;
  }

  getApi(): PostsModuleApi {
    const svc = this.service;
    const ns = this.noteService;
    const rs = this.repostService;
    const ds = this.deletionService;
    const rps = this.reportService;
    const RpsCls = this.ReportServiceClass;
    const mc = this.mentionCache;
    const ob = this.outboundRelays;
    return {
      createPost: options => svc?.createPost(options) ?? Promise.resolve(false),
      createReply: options =>
        svc?.createReply(options) ?? Promise.resolve(null),
      createHighlight: options =>
        svc?.createHighlight(options) ?? Promise.resolve(false),
      getNote: eventId => ns?.getNote(eventId) ?? Promise.resolve(null),
      getNotes: eventIds =>
        ns?.getNotes(eventIds) ?? Promise.resolve(new Map()),
      getCachedNote: eventId => ns?.getCachedNote(eventId) ?? null,
      registerNote: event => ns?.registerNote(event),
      registerNotes: events => ns?.registerNotes(events),
      hasNote: eventId => ns?.hasNote(eventId) ?? false,
      getCachedWriteRelays: pubkey => ob?.getCachedWriteRelays(pubkey) ?? [],
      hasUserReposted: noteId =>
        rs?.hasUserReposted(noteId) ?? Promise.resolve(false),
      publishRepost: options =>
        rs?.publishRepost(options) ??
        Promise.resolve({ success: false, error: 'Module not loaded' }),
      publishGenericRepost: options =>
        rs?.publishGenericRepost(options) ??
        Promise.resolve({ success: false, error: 'Module not loaded' }),
      deleteEvent: (eventId, reason) =>
        ds?.deleteEvent(eventId, reason) ?? Promise.resolve(false),
      deleteEvents: options =>
        ds?.deleteEvents(options) ?? Promise.resolve(false),
      deleteByCoordinates: (coordinates, reason) =>
        ds?.deleteByCoordinates(coordinates, reason) ?? Promise.resolve(false),
      subscribeDeleteProgress: cb =>
        BroadcastDeleteService.getInstance().subscribeProgress(cb),
      countActiveDeleteBroadcasts: () =>
        BroadcastDeleteService.getInstance().countActiveSilentJobs(),
      getDeleteProgressSummary: () =>
        BroadcastDeleteService.getInstance().getSilentProgress(),
      createReport: options =>
        rps?.createReport(options) ??
        Promise.resolve({ success: false, error: 'Module not loaded' }),
      getReportTypes: () => RpsCls?.getReportTypes() ?? [],
      getReportTypeLabel: type => RpsCls?.getReportTypeLabel(type) ?? '',
      getReportTypeDescription: type =>
        RpsCls?.getReportTypeDescription(type) ?? '',
      getMentionSuggestions: followingPubkeys =>
        mc?.getSuggestions(followingPubkeys) ?? Promise.resolve([]),
    };
  }
}

export default new PostsRuntime();
