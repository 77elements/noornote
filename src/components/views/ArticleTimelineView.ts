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
import { TypedEventBus } from '../../core/TypedEventBus';
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../services/PerAccountLocalStorage';

/**
 * Build the descriptive subtitle for the main article view, reflecting the
 * current FOAF degree selection so the user sees at a glance whose articles
 * are showing up.
 */
function articleFeedSubtitle(degree: number): string {
  switch (degree) {
    case 2:
      return 'Long-form content from your 1st and 2nd-degree follows';
    case 3:
      return 'Long-form content from your 1st, 2nd and 3rd-degree follows';
    default:
      return 'Long-form content from your follows';
  }
}

export class ArticleTimelineView extends View {
  private container: HTMLElement;
  private timeline: ArticleTimeline | null = null;
  private subtitleEl: HTMLElement | null = null;
  private settingsSubscription: string | null = null;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--article-timeline';
    this.render();
  }

  /**
   * Render the view
   */
  private render(): void {
    const degree = PerAccountLocalStorage.getInstance().get<number>(
      StorageKeys.ARTICLE_FEED_FOAF_DEGREE_MAIN,
      1
    );

    this.container.innerHTML = `
      <header class="article-timeline-view__header">
        <h1 class="article-timeline-view__title">Articles</h1>
        <p class="article-timeline-view__subtitle">${articleFeedSubtitle(degree)}</p>
      </header>
      <div class="article-timeline-view__content"></div>
    `;

    this.subtitleEl = this.container.querySelector(
      '.article-timeline-view__subtitle'
    );

    // Main variant: 20-per-page grid, click routes through ViewNavigationController
    // (right-pane aware, opens article in SCC if modifier key / right-pane mode).
    this.timeline = new ArticleTimeline({
      variant: 'main',
      onNavigate: (naddr, e) =>
        getViewNavigationController().openView('article', naddr, e),
    });
    const contentArea = this.container.querySelector(
      '.article-timeline-view__content'
    );
    contentArea?.appendChild(this.timeline.getElement());

    // Live-update subtitle when the FOAF degree changes.
    this.settingsSubscription = TypedEventBus.getInstance().on(
      'settings:article-foaf-degree-changed',
      payload => {
        if (payload.variant !== 'main' || !this.subtitleEl) return;
        this.subtitleEl.textContent = articleFeedSubtitle(payload.degree);
      }
    );
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
    if (this.settingsSubscription) {
      TypedEventBus.getInstance().off(this.settingsSubscription);
      this.settingsSubscription = null;
    }
    if (this.timeline) {
      this.timeline.destroy();
      this.timeline = null;
    }
    this.container.innerHTML = '';
    this.subtitleEl = null;
  }
}
