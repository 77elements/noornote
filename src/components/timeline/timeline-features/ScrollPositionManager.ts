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
   * Save current scroll position to CSM
   */
  save(): void {
    // Scroll is on .primary-content (not direct parent)
    const scrollContainer = this.container.closest('.primary-content');
    if (scrollContainer) {
      this.appState.setState('timeline', { scrollPosition: scrollContainer.scrollTop });
    }
  }

  /**
   * Restore saved scroll position from CSM
   */
  restore(): void {
    // Scroll is on .primary-content (not direct parent)
    const scrollContainer = this.container.closest('.primary-content');
    const savedPosition = this.appState.getState('timeline').scrollPosition;

    if (scrollContainer && savedPosition > 0) {
      // Use setTimeout to ensure DOM is fully rendered before scrolling
      setTimeout(() => {
        scrollContainer.scrollTop = savedPosition;
      }, 0);
    }
  }
}
