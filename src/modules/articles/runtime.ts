import type { ModuleRuntime, ModuleContext } from '../../core/ModuleLoader';
import type { ArticlesModuleApi } from './contracts';

export class ArticlesRuntime implements ModuleRuntime<ArticlesModuleApi> {
  private service: import('../../services/ArticleService').ArticleService | null = null;
  private ServiceClass: typeof import('../../services/ArticleService').ArticleService | null = null;
  private orchestrator: import('../../services/orchestration/LongFormOrchestrator').LongFormOrchestrator | null = null;
  private OrchestratorClass: typeof import('../../services/orchestration/LongFormOrchestrator').LongFormOrchestrator | null = null;
  private articleNotifService: import('../../services/ArticleNotificationService').ArticleNotificationService | null = null;
  private feedOrchestrator: import('../../services/orchestration/ArticleFeedOrchestrator').ArticleFeedOrchestrator | null = null;
  private FeedOrchestratorClass: typeof import('../../services/orchestration/ArticleFeedOrchestrator').ArticleFeedOrchestrator | null = null;

  async init(_ctx: ModuleContext): Promise<void> {
    const [articleMod, orchMod, notifMod, feedMod] = await Promise.all([
      import('../../services/ArticleService'),
      import('../../services/orchestration/LongFormOrchestrator'),
      import('../../services/ArticleNotificationService'),
      import('../../services/orchestration/ArticleFeedOrchestrator'),
    ]);
    this.ServiceClass = articleMod.ArticleService;
    this.service = articleMod.ArticleService.getInstance();
    this.OrchestratorClass = orchMod.LongFormOrchestrator;
    this.orchestrator = orchMod.LongFormOrchestrator.getInstance();
    this.articleNotifService = notifMod.ArticleNotificationService.getInstance();
    this.FeedOrchestratorClass = feedMod.ArticleFeedOrchestrator;
    this.feedOrchestrator = feedMod.ArticleFeedOrchestrator.getInstance();
  }

  async destroy(): Promise<void> {
    this.service = null;
    this.ServiceClass = null;
    this.orchestrator = null;
    this.OrchestratorClass = null;
    this.articleNotifService = null;
    this.feedOrchestrator = null;
    this.FeedOrchestratorClass = null;
  }

  getApi(): ArticlesModuleApi {
    const svc = this.service;
    const Cls = this.ServiceClass;
    const orch = this.orchestrator;
    const OrchCls = this.OrchestratorClass;
    const ans = this.articleNotifService;
    const fo = this.feedOrchestrator;
    const FoCls = this.FeedOrchestratorClass;
    return {
      publishArticle: (options) => svc?.publishArticle(options) ?? Promise.resolve(null),
      saveDraft: (options) => svc?.saveDraft(options) ?? Promise.resolve(null),
      generateSlug: (title) => Cls?.generateSlug(title) ?? '',
      generateIdentifier: (title) => Cls?.generateIdentifier(title) ?? '',
      fetchAddressableEvent: (naddrRef) => orch?.fetchAddressableEvent(naddrRef) ?? Promise.resolve(null),
      extractArticleMetadata: (event) => OrchCls?.extractArticleMetadata(event) ?? { title: '', image: '', summary: '', publishedAt: 0, identifier: '', topics: [] },
      isSubscribedToArticleNotifications: (pubkey) => ans?.isSubscribed(pubkey) ?? false,
      toggleArticleNotifications: (pubkey) => ans?.toggle(pubkey) ?? false,
      loadInitialArticleFeed: () => fo?.loadInitial() ?? Promise.resolve({ articles: [], hasMore: false }),
      loadMoreArticleFeed: () => fo?.loadMore() ?? Promise.resolve({ articles: [], hasMore: false }),
      extractArticleFeedMetadata: (event) => FoCls?.extractMetadata(event) ?? { title: '', image: '', summary: '', publishedAt: 0, identifier: '', topics: [] },
    };
  }
}

export default new ArticlesRuntime();
