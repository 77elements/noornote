/**
 * Infinite Scroll Component
 * Single responsibility: Detect when user scrolls near bottom and emit load event
 * Uses IntersectionObserver to efficiently monitor scroll position
 * Includes integrated loading indicator with pulsing animation
 */

import { _ } from '../../i18n';

export interface InfiniteScrollConfig {
  rootMargin?: string;
  threshold?: number;
  debounceMs?: number;
  loadingMessage?: string;
  showLoadingIndicator?: boolean;
}

export class InfiniteScroll {
  private observer: IntersectionObserver | null = null;
  private sentinelElement: HTMLElement | null = null;
  private loadingIndicator: HTMLElement | null = null;
  private containerElement: HTMLElement | null = null;
  private onLoadMore: () => void;
  private debounceTimer: number | null = null;
  private pendingFrame: number | null = null;
  private pendingRoot: Element | null | (() => Element | null) = null;
  private config: Required<InfiniteScrollConfig>;

  constructor(onLoadMore: () => void, config: InfiniteScrollConfig = {}) {
    this.onLoadMore = onLoadMore;
    this.config = {
      rootMargin: config.rootMargin || '200px',
      threshold: config.threshold || 0,
      debounceMs: config.debounceMs || 300,
      loadingMessage: config.loadingMessage || _('Loading more...'),
      showLoadingIndicator: config.showLoadingIndicator !== false, // default true
    };
  }

  /**
   * Start observing a container by creating and monitoring a sentinel element.
   *
   * @param root  The scroll container the sentinel lives inside. IMPORTANT when
   *   the content scrolls in an inner overflow element (not the page): with the
   *   default viewport root the inner container clips the sentinel, so rootMargin
   *   prefetch has no effect and load only fires at the very last item. Passing
   *   the scroll container makes rootMargin trigger the configured distance early.
   *   A function is resolved LAZILY when the observation actually starts — the
   *   right root may depend on layout that only exists once the container is
   *   attached (contextual overflow rules don't match on detached subtrees).
   *
   * When the container is detached (focus surfaces render before the stage
   * appends them), the sentinel + loading indicator are created immediately
   * (renderers insert items before the sentinel), but the IntersectionObserver
   * only starts once the container enters the document — an observer created
   * against a detached root never re-evaluates after attachment.
   */
  observe(
    containerElement: HTMLElement,
    root: Element | null | (() => Element | null) = null
  ): void {
    this.containerElement = containerElement;

    if (this.observer) {
      this.disconnect();
    }

    // Create sentinel element first (items will be inserted before it)
    this.sentinelElement = document.createElement('div');
    this.sentinelElement.className = 'infinite-scroll-sentinel';
    this.sentinelElement.style.height = '1px';
    this.sentinelElement.style.visibility = 'hidden';
    this.containerElement.appendChild(this.sentinelElement);

    // Create loading indicator AFTER sentinel (so it stays at the end)
    if (this.config.showLoadingIndicator) {
      this.loadingIndicator = document.createElement('div');
      this.loadingIndicator.className = 'infinite-scroll-loading';
      this.loadingIndicator.style.display = 'none';
      this.loadingIndicator.innerHTML = `
        <p>${this.config.loadingMessage}</p>
      `;
      this.containerElement.appendChild(this.loadingIndicator);
    }

    if (this.containerElement.isConnected) {
      this.startObservation(root);
    } else {
      // Detached: poll until the stage/view attaches the container, then
      // resolve the root against the live layout and start observing.
      this.pendingRoot = root;
      const poll = (): void => {
        if (!this.containerElement || !this.sentinelElement) return;
        if (this.containerElement.isConnected) {
          this.pendingFrame = null;
          this.startObservation(this.pendingRoot);
          this.pendingRoot = null;
          return;
        }
        this.pendingFrame = requestAnimationFrame(poll);
      };
      this.pendingFrame = requestAnimationFrame(poll);
    }
  }

  /**
   * Create the IntersectionObserver against the (possibly lazily resolved)
   * root and start watching the sentinel. Called once the container is
   * connected — never while detached.
   */
  private startObservation(
    root: Element | null | (() => Element | null)
  ): void {
    if (!this.sentinelElement) return;
    const resolvedRoot = typeof root === 'function' ? root() : root;

    this.observer = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            this.triggerLoadMore();
          }
        });
      },
      {
        root: resolvedRoot,
        rootMargin: this.config.rootMargin,
        threshold: this.config.threshold,
      }
    );

    this.observer.observe(this.sentinelElement);
  }

  /**
   * Stop observing
   */
  disconnect(): void {
    if (this.pendingFrame !== null) {
      cancelAnimationFrame(this.pendingFrame);
      this.pendingFrame = null;
    }
    this.pendingRoot = null;
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.loadingIndicator) {
      this.loadingIndicator.remove();
      this.loadingIndicator = null;
    }
    if (this.sentinelElement) {
      this.sentinelElement.remove();
      this.sentinelElement = null;
    }
  }

  /**
   * Temporarily pause observation
   */
  pause(): void {
    if (this.observer && this.sentinelElement) {
      this.observer.unobserve(this.sentinelElement);
    }
  }

  /**
   * Resume observation
   */
  resume(): void {
    if (this.observer && this.sentinelElement) {
      this.observer.observe(this.sentinelElement);
    }
  }

  /**
   * Show loading indicator
   */
  showLoading(): void {
    if (this.loadingIndicator) {
      this.loadingIndicator.style.display = 'flex';
    }
  }

  /**
   * Hide loading indicator
   */
  hideLoading(): void {
    if (this.loadingIndicator) {
      this.loadingIndicator.style.display = 'none';
    }
  }

  /**
   * Refresh sentinel position (call after appending new content)
   */
  refresh(): void {
    if (this.sentinelElement && this.containerElement) {
      this.containerElement.appendChild(this.sentinelElement);

      // Also re-append loading indicator to keep it after sentinel
      if (this.loadingIndicator) {
        this.containerElement.appendChild(this.loadingIndicator);
      }
    }
  }

  /**
   * Re-evaluate the sentinel after a load completed.
   *
   * The IntersectionObserver only fires on intersection TRANSITIONS. If the
   * sentinel was already visible while a load ran (its transition fired the
   * trigger that started the load) and the load appended too few notes to push
   * the sentinel out of view, the intersection state never changes — no new
   * event ever fires and the feed deadlocks right below a short first screen.
   * unobserve→observe forces a fresh evaluation cycle that reports the
   * CURRENT intersection state, so a still-visible sentinel re-triggers
   * loadMore immediately. If the scroller now overflows, the re-observation
   * reports not-intersecting and nothing happens.
   */
  revalidate(): void {
    if (!this.observer || !this.sentinelElement) return;
    this.observer.unobserve(this.sentinelElement);
    this.observer.observe(this.sentinelElement);
  }

  /**
   * Clean up and destroy
   */
  destroy(): void {
    this.disconnect();
    this.containerElement = null;
  }

  /**
   * Debounced trigger to prevent rapid fire events
   */
  private triggerLoadMore(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      this.onLoadMore();
    }, this.config.debounceMs);
  }
}
