/**
 * Focus surface: Articles (v2).
 *
 * Wraps the classic ArticleTimelineView (list) and ArticleView (detail)
 * into ONE surface for the focus column: clicking an article swaps the
 * list for the detail view INSIDE the surface — the classic SCC tab
 * system does not exist in the shell. A small back control returns to
 * the list. The URL follows along (/articles ↔ /article/:naddr) without
 * touching the Router's view mounting.
 *
 * The list view is cached: back preserves feed + scroll position.
 */

import type {
  FocusDomainSurface,
  FocusDomainSurfaceView,
} from './focusDomains';
import { createFocusSurfaceFrame } from './focusSurfaceFrame';
import { Router } from '../services/Router';

export class ArticlesSurface implements FocusDomainSurfaceView {
  private frame = createFocusSurfaceFrame('focus-surface--articles', () =>
    this.showList()
  );

  private listView:
    | import('../components/views/ArticleTimelineView').ArticleTimelineView
    | null = null;
  private detailView:
    | import('../components/views/ArticleView').ArticleView
    | null = null;
  private detailEl: HTMLElement | null = null;
  /** List scroll position, saved when a detail replaces the list. */
  private savedListScroll = 0;

  /** The focus column's scroll container (the stage's surface slot). */
  private get scrollSlot(): HTMLElement | null {
    return this.frame.element.parentElement as HTMLElement | null;
  }

  constructor() {
    // List mounts immediately — the surface IS the articles domain's content.
    void this.ensureList().then(list => {
      if (list) this.frame.element.appendChild(list.getElement());
    });
  }

  /** The surface contract: this object doubles as the view handle. */
  asSurface(): FocusDomainSurface {
    return { element: this.frame.element, view: this };
  }

  /**
   * Focus navigation seam: render the article detail in-column. Returns
   * false for view types this surface does not own (falls through to
   * the classic navigation).
   */
  handleFocusNav(viewType: string, param?: string): boolean {
    if (viewType !== 'article' || !param) return false;
    void this.showArticle(param);
    return true;
  }

  private async ensureList(): Promise<
    import('../components/views/ArticleTimelineView').ArticleTimelineView | null
  > {
    if (!this.listView) {
      const { ArticleTimelineView } = await import(
        '../components/views/ArticleTimelineView'
      );
      // The articles list already routes clicks locally via onOpenArticle;
      // handleFocusNav covers article links coming from other surfaces.
      this.listView = new ArticleTimelineView({
        onOpenArticle: naddr => void this.showArticle(naddr),
      });
    }
    return this.listView;
  }

  private async showArticle(naddr: string): Promise<void> {
    const list = await this.ensureList();
    if (!list) return;
    // Save the list's column scroll before the removal collapses the
    // scrollable area (restored on back / list return).
    this.savedListScroll = this.scrollSlot?.scrollTop ?? 0;
    list.getElement().remove();
    // A previous detail (if any) is stale — the back control always
    // destroys it, this is just a guard (destroy() does not detach the
    // element, so remove it explicitly).
    this.detailEl?.remove();
    this.detailView?.destroy();
    const { ArticleView } = await import('../components/views/ArticleView');
    this.detailView = new ArticleView(naddr);
    this.detailEl = this.detailView.getElement();
    this.frame.element.appendChild(this.detailEl);
    if (this.scrollSlot) this.scrollSlot.scrollTop = 0;
    this.frame.setBackVisible(true);
    // Keep the classic URL scheme, in place (no view mounting, no history).
    Router.getInstance().replaceUrl(`/article/${naddr}`);
  }

  private showList(): void {
    if (!this.listView) return;
    // ArticleView.destroy() does not detach its element — remove it here,
    // otherwise it stays in the frame and pushes the list below it.
    this.detailEl?.remove();
    this.detailView?.destroy();
    this.detailView = null;
    this.detailEl = null;
    this.frame.element.appendChild(this.listView.getElement());
    if (this.scrollSlot) this.scrollSlot.scrollTop = this.savedListScroll;
    this.frame.setBackVisible(false);
    Router.getInstance().replaceUrl('/articles');
  }

  reset(): void {
    if (!this.detailView) return;
    this.detailEl?.remove();
    this.detailView.destroy();
    this.detailView = null;
    this.detailEl = null;
    if (this.listView) {
      this.frame.element.appendChild(this.listView.getElement());
      if (this.scrollSlot) this.scrollSlot.scrollTop = this.savedListScroll;
    }
    this.frame.setBackVisible(false);
  }

  back(): void {
    this.showList();
  }

  destroy(): void {
    this.listView?.destroy();
    this.listView = null;
    this.detailView?.destroy();
    this.detailView = null;
    this.detailEl = null;
    this.frame.destroy();
  }
}

/** Surface factory for the focusDomains registry. */
export const articlesSurface = async (): Promise<FocusDomainSurface> => {
  const surface = new ArticlesSurface();
  return surface.asSurface();
};
