/**
 * Focus surface: Articles (v2).
 *
 * A FocusListDetailSurface wired to the articles domain: the cached list
 * is the classic ArticleTimelineView, clicking an article swaps the
 * classic ArticleView INSIDE the surface — the classic SCC tab system
 * does not exist in the shell. The URL follows along (/articles ↔
 * /article/:naddr) without touching the Router's view mounting.
 */

import type { FocusDomainSurface } from './focusDomains';
import { FocusListDetailSurface } from './focusListDetailSurface';

export const articlesSurface = async (): Promise<FocusDomainSurface> => {
  const surface = new FocusListDetailSurface({
    className: 'focus-surface--articles',
    navViewType: 'article',
    listRoute: '/articles',
    detailRoute: naddr => `/article/${naddr}`,
    // The articles list routes clicks locally via onOpenArticle;
    // handleFocusNav covers article links coming from other surfaces.
    createList: async () => {
      const { ArticleTimelineView } = await import(
        '../components/views/ArticleTimelineView'
      );
      return new ArticleTimelineView({
        onOpenArticle: naddr => void surface.openDetail(naddr),
      });
    },
    createDetail: async naddr => {
      const { ArticleView } = await import('../components/views/ArticleView');
      return new ArticleView(naddr);
    },
    // The list view has no internal scroll — the column scrolls, so the
    // feed position survives the list ↔ detail swap.
    preserveListScroll: true,
  });
  return surface.asSurface();
};
