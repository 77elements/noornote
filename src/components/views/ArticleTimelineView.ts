/**
 * ArticleTimelineView
 * View wrapper for ArticleTimeline component
 *
 * Self-contained view for article feed feature.
 * Can be easily disabled by removing route and sidebar entry.
 */

import { View } from './View';
import { ArticleTimeline } from '../article/ArticleTimeline';
import { getViewNavigationController } from '../../services/ViewNavigationController';
import { createFocusViewHeader } from '../../helpers/focusViewHeader';
import { _ } from '../../i18n';

export class ArticleTimelineView extends View {
  private container: HTMLElement;
  private timeline: ArticleTimeline | null = null;

  /**
   * Optional focus-side click target: when provided, article clicks are
   * handed here instead of going through ViewNavigationController (classic
   * Router navigation / SCC tab system). Used by the Focus UI (v2) shell,
   * which renders the article inside its own surface column.
   */
  constructor(private options?: { onOpenArticle?: (naddr: string) => void }) {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--article-timeline';
    this.render();
  }

  /**
   * Render the view
   */
  private render(): void {
    // Shared heading: the bare h1. Write Article lives ONCE — the side
    // stack's primary action row (v2) / the +New Post dropup (v1).
    this.container.appendChild(
      createFocusViewHeader({
        title: _('Articles'),
        object: 'articles',
      })
    );
    this.container.insertAdjacentHTML(
      'beforeend',
      `<div class="article-timeline-view__content"></div>`
    );

    // Main variant: 20-per-page grid, click routes through ViewNavigationController
    // (right-pane aware, opens article in SCC if modifier key / right-pane mode).
    this.timeline = new ArticleTimeline({
      variant: 'main',
      onNavigate: (naddr, e) =>
        this.options?.onOpenArticle
          ? this.options.onOpenArticle(naddr)
          : getViewNavigationController().openView('article', naddr, e),
    });
    const contentArea = this.container.querySelector(
      '.article-timeline-view__content'
    );
    contentArea?.appendChild(this.timeline.getElement());
  }

  /**
   * Get element
   */
  public getElement(): HTMLElement {
    return this.container;
  }

  /**
   * Destroy view
   */
  public destroy(): void {
    if (this.timeline) {
      this.timeline.destroy();
      this.timeline = null;
    }
    this.container.innerHTML = '';
  }
}
