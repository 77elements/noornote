import type { ArticleOptions } from '../../services/ArticleService';

export type { ArticleOptions };

export interface ArticlesModuleApi {
  publishArticle(options: ArticleOptions): Promise<string | null>;
  saveDraft(options: ArticleOptions): Promise<string | null>;
  generateSlug(title: string): string;
  generateIdentifier(title?: string): string;
}
