/**
 * ScrollPositionManager - Saves/restores a timeline's scroll position across
 * navigation (e.g. ProfileView -> note -> back lands where you left off).
 *
 * The position is kept in a PER-INSTANCE field, not a shared global key. Each
 * timeline (main feed, ProfileView, tribe feed) is a kept-alive cached view with
 * its own manager, so they restore independently and never clobber each other.
 */

export class ScrollPositionManager {
  private container: HTMLElement;
  /** This view's last scroll offset (0 = top / not yet saved). */
  private savedPosition = 0;

  constructor(container: HTMLElement) {
    this.container = container;
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
    // Fallback to .primary-content for other cases (e.g. ProfileView)
    return this.container.closest('.primary-content');
  }

  /**
   * Save current scroll position (called when navigating away from this view)
   */
  save(): void {
    const scrollContainer = this.getScrollContainer();
    if (scrollContainer) {
      this.savedPosition = scrollContainer.scrollTop;
    }
  }

  /**
   * Restore saved scroll position (called when returning to this view).
   * Restores across two animation frames so the (re-attached) content is laid
   * out before we set scrollTop — a single setTimeout(0) lands before reflow.
   */
  restore(): void {
    const scrollContainer = this.getScrollContainer();
    if (scrollContainer && this.savedPosition > 0) {
      const target = this.savedPosition;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollContainer.scrollTop = target;
        });
      });
    }
  }
}
