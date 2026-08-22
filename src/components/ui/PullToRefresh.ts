/**
 * PullToRefresh - Touch-based pull-to-refresh for scrollable containers
 *
 * Attaches to a container element (.primary-content) and detects when the user
 * pulls down while all scrollable ancestors between the touch target and the
 * container are at scrollTop=0. Works with nested scroll containers like
 * TimelineView's .timeline-view__timeline.
 *
 * @component PullToRefresh
 * @used-by MainLayout (attached to .primary-content)
 */

export class PullToRefresh {
  private container: HTMLElement;
  private onRefresh: () => void;
  private indicator: HTMLElement;
  private startY = 0;
  private currentY = 0;
  private pulling = false;
  private refreshing = false;

  private readonly THRESHOLD = 70;
  private readonly MAX_PULL = 110;
  private readonly RESISTANCE = 0.45;

  private boundTouchStart: (e: TouchEvent) => void;
  private boundTouchMove: (e: TouchEvent) => void;
  private boundTouchEnd: () => void;

  constructor(container: HTMLElement, onRefresh: () => void) {
    this.container = container;
    this.onRefresh = onRefresh;

    this.indicator = document.createElement('div');
    this.indicator.className = 'pull-to-refresh';
    this.indicator.innerHTML = `
      <div class="pull-to-refresh__spinner">
        <svg width="24" height="24"><use href="#icon-pull-refresh"/></svg>
      </div>`;

    this.boundTouchStart = this.onTouchStart.bind(this);
    this.boundTouchMove = this.onTouchMove.bind(this);
    this.boundTouchEnd = this.onTouchEnd.bind(this);

    this.container.addEventListener('touchstart', this.boundTouchStart, {
      passive: true,
    });
    this.container.addEventListener('touchmove', this.boundTouchMove, {
      passive: false,
    });
    this.container.addEventListener('touchend', this.boundTouchEnd, {
      passive: true,
    });
  }

  /**
   * Check if all scrollable elements from touch target up to container are at top
   */
  private isScrolledToTop(target: EventTarget | null): boolean {
    let el = target as HTMLElement | null;
    while (el && el !== this.container) {
      if (el.scrollHeight > el.clientHeight && el.scrollTop > 0) {
        return false;
      }
      el = el.parentElement;
    }
    // Also check the container itself
    return this.container.scrollTop <= 0;
  }

  private onTouchStart(e: TouchEvent): void {
    if (this.refreshing) return;
    const touch = e.touches[0];
    if (!touch) return;

    if (this.isScrolledToTop(e.target)) {
      this.startY = touch.clientY;
      this.pulling = true;
      // Ensure indicator is at the top of current content
      this.ensureIndicator();
    }
  }

  private ensureIndicator(): void {
    // Insert indicator as first child of the actual scroll container or its first view-content child
    const viewContent = this.container.querySelector('.view-content');
    const parent = viewContent || this.container;
    if (!parent.contains(this.indicator)) {
      parent.prepend(this.indicator);
    }
  }

  private onTouchMove(e: TouchEvent): void {
    if (!this.pulling || this.refreshing) return;
    const touch = e.touches[0];
    if (!touch) return;

    if (!this.isScrolledToTop(e.target)) {
      this.pulling = false;
      this.resetIndicator();
      return;
    }

    const deltaY = (touch.clientY - this.startY) * this.RESISTANCE;
    if (deltaY < 0) return;

    e.preventDefault();

    this.currentY = Math.min(deltaY, this.MAX_PULL);
    const progress = Math.min(this.currentY / this.THRESHOLD, 1);

    this.indicator.style.height = `${this.currentY}px`;
    this.indicator.style.opacity = `${progress}`;

    const spinner = this.indicator.querySelector(
      '.pull-to-refresh__spinner'
    ) as HTMLElement;
    if (spinner) {
      spinner.style.transform = `rotate(${progress * 360}deg)`;
      spinner.style.opacity = progress > 0.2 ? '1' : `${progress / 0.2}`;
    }

    if (progress >= 1) {
      this.indicator.classList.add('pull-to-refresh--ready');
    } else {
      this.indicator.classList.remove('pull-to-refresh--ready');
    }
  }

  private onTouchEnd(): void {
    if (!this.pulling || this.refreshing) return;
    this.pulling = false;

    if (this.currentY >= this.THRESHOLD) {
      this.refreshing = true;
      this.indicator.classList.add('pull-to-refresh--refreshing');
      this.indicator.classList.remove('pull-to-refresh--ready');
      this.indicator.style.height = `${this.THRESHOLD * 0.6}px`;

      this.onRefresh();
      setTimeout(() => this.finishRefresh(), 600);
    } else {
      this.resetIndicator();
    }

    this.currentY = 0;
  }

  private finishRefresh(): void {
    this.refreshing = false;
    this.resetIndicator();
  }

  private resetIndicator(): void {
    this.indicator.style.height = '0';
    this.indicator.style.opacity = '0';
    this.indicator.classList.remove(
      'pull-to-refresh--ready',
      'pull-to-refresh--refreshing'
    );
  }

  public destroy(): void {
    this.container.removeEventListener('touchstart', this.boundTouchStart);
    this.container.removeEventListener('touchmove', this.boundTouchMove);
    this.container.removeEventListener('touchend', this.boundTouchEnd);
    this.indicator.remove();
  }
}
