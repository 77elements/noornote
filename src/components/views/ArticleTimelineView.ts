/**
 * ArticleTimelineView
 * View wrapper for ArticleTimeline component
 *
 * Self-contained view for article feed feature.
 * Can be easily disabled by removing route and sidebar entry.
 */

import { View } from './View';
import { ArticleTimeline } from '../article/ArticleTimeline';

export class ArticleTimelineView extends View {
  private container: HTMLElement;
  private timeline: ArticleTimeline | null = null;

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
    this.container.innerHTML = `
      <header class="article-timeline-view__header">
        <h1 class="article-timeline-view__title">Articles</h1>
        <p class="article-timeline-view__subtitle">Long-form content from the network</p>
      </header>
      <div class="article-timeline-view__content"></div>
    `;

    // Create and mount timeline
    this.timeline = new ArticleTimeline();
    const contentArea = this.container.querySelector('.article-timeline-view__content');
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
