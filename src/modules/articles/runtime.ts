import type { ModuleRuntime, ModuleContext } from '../../core/ModuleLoader';
import type { ArticlesModuleApi } from './contracts';

export class ArticlesRuntime implements ModuleRuntime<ArticlesModuleApi> {
  private service: import('../../services/ArticleService').ArticleService | null = null;
  private ServiceClass: typeof import('../../services/ArticleService').ArticleService | null = null;
  private orchestrator: import('../../services/orchestration/LongFormOrchestrator').LongFormOrchestrator | null = null;
  private OrchestratorClass: typeof import('../../services/orchestration/LongFormOrchestrator').LongFormOrchestrator | null = null;

  async init(_ctx: ModuleContext): Promise<void> {
    const [articleMod, orchMod] = await Promise.all([
      import('../../services/ArticleService'),
      import('../../services/orchestration/LongFormOrchestrator'),
    ]);
    this.ServiceClass = articleMod.ArticleService;
    this.service = articleMod.ArticleService.getInstance();
    this.OrchestratorClass = orchMod.LongFormOrchestrator;
    this.orchestrator = orchMod.LongFormOrchestrator.getInstance();
  }

  async destroy(): Promise<void> {
    this.service = null;
    this.ServiceClass = null;
    this.orchestrator = null;
    this.OrchestratorClass = null;
  }

  getApi(): ArticlesModuleApi {
    const svc = this.service;
    const Cls = this.ServiceClass;
    const orch = this.orchestrator;
    const OrchCls = this.OrchestratorClass;
    return {
      publishArticle: (options) => svc?.publishArticle(options) ?? Promise.resolve(null),
      saveDraft: (options) => svc?.saveDraft(options) ?? Promise.resolve(null),
      generateSlug: (title) => Cls?.generateSlug(title) ?? '',
      generateIdentifier: (title) => Cls?.generateIdentifier(title) ?? '',
      fetchAddressableEvent: (naddrRef) => orch?.fetchAddressableEvent(naddrRef) ?? Promise.resolve(null),
      extractArticleMetadata: (event) => OrchCls?.extractArticleMetadata(event) ?? { title: '', image: '', summary: '', publishedAt: 0, identifier: '', topics: [] },
    };
  }
}

export default new ArticlesRuntime();
