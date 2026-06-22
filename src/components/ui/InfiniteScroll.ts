/**
 * Infinite Scroll Component
 * Single responsibility: Detect when user scrolls near bottom and emit load event
 * Uses IntersectionObserver to efficiently monitor scroll position
 * Includes integrated loading indicator with pulsing animation
 */

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
  private config: Required<InfiniteScrollConfig>;

  constructor(onLoadMore: () => void, config: InfiniteScrollConfig = {}) {
    this.onLoadMore = onLoadMore;
    this.config = {
      rootMargin: config.rootMargin || '200px',
      threshold: config.threshold || 0,
      debounceMs: config.debounceMs || 300,
      loadingMessage: config.loadingMessage || 'Loading more...',
      showLoadingIndicator: config.showLoadingIndicator !== false // default true
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
   */
  observe(containerElement: HTMLElement, root: Element | null = null): void {
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

    this.observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            this.triggerLoadMore();
          }
        });
      },
      {
        root,
        rootMargin: this.config.rootMargin,
        threshold: this.config.threshold
      }
    );

    this.observer.observe(this.sentinelElement);
  }

  /**
   * Stop observing
   */
  disconnect(): void {
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