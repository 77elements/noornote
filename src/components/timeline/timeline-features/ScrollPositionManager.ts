/**
 * ScrollPositionManager - Manages scroll position persistence
 * Saves/restores scroll position to/from CSM for seamless navigation
 * Extracts from: TimelineUI.saveScrollPosition() / restoreScrollPosition()
 */

import { AppState } from '../../../services/AppState';

export class ScrollPositionManager {
  private container: HTMLElement;
  private appState: AppState;

  constructor(container: HTMLElement) {
    this.container = container;
    this.appState = AppState.getInstance();
  }

  /**
   * Get the actual scrollable container
   * TimelineView uses .timeline-view__timeline as scroll container
   */
  private getScrollContainer(): Element | null {
    // TimelineView wraps Timeline in .timeline-view__timeline (the scrollable element)
    const timelineViewContainer = this.container.closest('.timeline-view__timeline');
    if (timelineViewContainer) {
      return timelineViewContainer;
    }
    // Fallback to .primary-content for other cases
    return this.container.closest('.primary-content');
  }

  /**
   * Save current scroll position to CSM
   */
  save(): void {
    const scrollContainer = this.getScrollContainer();
    if (scrollContainer) {
      this.appState.setState('timeline', { scrollPosition: scrollContainer.scrollTop });
    }
  }

  /**
   * Restore saved scroll position from CSM
   */
  restore(): void {
    const scrollContainer = this.getScrollContainer();
    const savedPosition = this.appState.getState('timeline').scrollPosition;

    if (scrollContainer && savedPosition > 0) {
      // Use setTimeout to ensure DOM is fully rendered before scrolling
      setTimeout(() => {
        scrollContainer.scrollTop = savedPosition;
      }, 0);
    }
  }
}
