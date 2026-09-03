import type { ModuleRuntime, ModuleContext } from '../../core/ModuleLoader';
import type { ArticlesModuleApi } from './contracts';

export class ArticlesRuntime implements ModuleRuntime<ArticlesModuleApi> {
  private service:
    | import('../../services/ArticleService').ArticleService
    | null = null;
  private ServiceClass:
    | typeof import('../../services/ArticleService').ArticleService
    | null = null;
  private orchestrator:
    | import('../../services/orchestration/LongFormOrchestrator').LongFormOrchestrator
    | null = null;
  private OrchestratorClass:
    | typeof import('../../services/orchestration/LongFormOrchestrator').LongFormOrchestrator
    | null = null;
  private articleNotifService:
    | import('../../services/ArticleNotificationService').ArticleNotificationService
    | null = null;
  private FeedOrchestratorClass:
    | typeof import('../../services/orchestration/ArticleFeedOrchestrator').ArticleFeedOrchestrator
    | null = null;
  private transport:
    | import('../../services/transport/NostrTransport').NostrTransport
    | null = null;

  async init(_ctx: ModuleContext): Promise<void> {
    const [articleMod, orchMod, notifMod, feedMod, transportMod] =
      await Promise.all([
        import('../../services/ArticleService'),
        import('../../services/orchestration/LongFormOrchestrator'),
        import('../../services/ArticleNotificationService'),
        import('../../services/orchestration/ArticleFeedOrchestrator'),
        import('../../services/transport/NostrTransport'),
      ]);
    this.ServiceClass = articleMod.ArticleService;
    this.service = articleMod.ArticleService.getInstance();
    this.OrchestratorClass = orchMod.LongFormOrchestrator;
    this.orchestrator = orchMod.LongFormOrchestrator.getInstance();
    this.articleNotifService =
      notifMod.ArticleNotificationService.getInstance();
    this.FeedOrchestratorClass = feedMod.ArticleFeedOrchestrator;
    this.transport = transportMod.NostrTransport.getInstance();
  }

  async destroy(): Promise<void> {
    this.service = null;
    this.ServiceClass = null;
    this.orchestrator = null;
    this.OrchestratorClass = null;
    this.articleNotifService = null;
    this.FeedOrchestratorClass = null;
    this.transport = null;
  }

  getApi(): ArticlesModuleApi {
    const svc = this.service;
    const Cls = this.ServiceClass;
    const orch = this.orchestrator;
    const OrchCls = this.OrchestratorClass;
    const ans = this.articleNotifService;
    const FoCls = this.FeedOrchestratorClass;
    const tp = this.transport;
    return {
      publishArticle: options =>
        svc?.publishArticle(options) ?? Promise.resolve(null),
      saveDraft: options => svc?.saveDraft(options) ?? Promise.resolve(null),
      generateSlug: title => Cls?.generateSlug(title) ?? '',
      generateIdentifier: title => Cls?.generateIdentifier(title) ?? '',
      fetchAddressableEvent: naddrRef =>
        orch?.fetchAddressableEvent(naddrRef) ?? Promise.resolve(null),
      extractArticleMetadata: event =>
        OrchCls?.extractArticleMetadata(event) ?? {
          title: '',
          image: '',
          summary: '',
          publishedAt: 0,
          identifier: '',
          topics: [],
        },
      isSubscribedToArticleNotifications: pubkey =>
        ans?.isSubscribed(pubkey) ?? false,
      toggleArticleNotifications: pubkey => ans?.toggle(pubkey) ?? false,
      getSubscribedArticlePubkeys: () => ans?.getSubscribedPubkeys() ?? [],
      fetchFollowingArticles: opts =>
        FoCls?.fetchFollowingArticles(opts) ??
        Promise.resolve({ articles: [], oldestTimestamp: opts.until }),
      getArticleAddressableId: event =>
        FoCls?.getAddressableId(event) ?? `${event.pubkey}:`,
      extractArticleFeedMetadata: event =>
        FoCls?.extractMetadata(event) ?? {
          title: '',
          image: '',
          summary: '',
          publishedAt: 0,
          identifier: '',
          topics: [],
        },
      watchLiveStream: (event, streamRelays, onUpdate) => {
        if (!tp) return () => {};
        const dTag = event.tags.find(t => t[0] === 'd')?.[1];
        if (!dTag) return () => {};
        const relays =
          streamRelays.length > 0 ? streamRelays : tp.getReadRelays();
        const subId = `live-stream-status-${event.id}`;
        void tp.subscribeLive(
          relays,
          [{ kinds: [30311 as number], authors: [event.pubkey], '#d': [dTag] }],
          subId,
          onUpdate
        );
        return () => tp.unsubscribeLive(subId);
      },
    };
  }
}

export default new ArticlesRuntime();
