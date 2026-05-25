import type { ModuleRuntime, ModuleContext } from '../../core/ModuleLoader';
import type { ArticlesModuleApi } from './contracts';

export class ArticlesRuntime implements ModuleRuntime<ArticlesModuleApi> {
  private service: import('../../services/ArticleService').ArticleService | null = null;
  private ServiceClass: typeof import('../../services/ArticleService').ArticleService | null = null;

  async init(_ctx: ModuleContext): Promise<void> {
    const mod = await import('../../services/ArticleService');
    this.ServiceClass = mod.ArticleService;
    this.service = mod.ArticleService.getInstance();
  }

  async destroy(): Promise<void> {
    this.service = null;
    this.ServiceClass = null;
  }

  getApi(): ArticlesModuleApi {
    const svc = this.service;
    const Cls = this.ServiceClass;
    return {
      publishArticle: (options) => svc?.publishArticle(options) ?? Promise.resolve(null),
      saveDraft: (options) => svc?.saveDraft(options) ?? Promise.resolve(null),
      generateSlug: (title) => Cls?.generateSlug(title) ?? '',
      generateIdentifier: (title) => Cls?.generateIdentifier(title) ?? '',
    };
  }
}

export default new ArticlesRuntime();
