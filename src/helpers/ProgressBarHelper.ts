/**
 * ProgressBarHelper
 * Manages a CSS-based progress bar on any element
 *
 * Requirements:
 * - Element must have progress-bar styles applied (via mixin or utility class)
 * - Uses CSS classes: .progress-bar--loading, .progress-bar--complete
 * - Uses CSS variable: --progress (0-100%)
 *
 * Usage:
 * ```typescript
 * const progress = new ProgressBarHelper(element);
 * progress.start();
 * progress.update(50); // 50%
 * progress.complete(); // Fade out
 * ```
 */

export interface ProgressBarOptions {
  /** Delay in ms before removing complete class (default: 700) */
  fadeOutDelay?: number;
  /** CSS class prefix (default: 'progress-bar') */
  classPrefix?: string;
}

export class ProgressBarHelper {
  private element: HTMLElement;
  private options: Required<ProgressBarOptions>;
  private fadeOutTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(element: HTMLElement, options: ProgressBarOptions = {}) {
    this.element = element;
    this.options = {
      fadeOutDelay: options.fadeOutDelay ?? 700,
      classPrefix: options.classPrefix ?? 'progress-bar',
    };
  }

  /**
   * Start the progress bar (shows it at 0%)
   */
  start(): void {
    this.clearFadeOutTimer();
    this.element.classList.remove(`${this.options.classPrefix}--complete`);
    this.element.classList.add(`${this.options.classPrefix}--loading`);
    this.element.style.setProperty('--progress', '0%');
  }

  /**
   * Update progress (0-100)
   */
  update(percent: number): void {
    const clamped = Math.min(Math.max(percent, 0), 100);
    this.element.style.setProperty('--progress', `${clamped}%`);
  }

  /**
   * Complete the progress bar (fade out)
   */
  complete(): void {
    this.clearFadeOutTimer();
    this.element.classList.remove(`${this.options.classPrefix}--loading`);
    this.element.classList.add(`${this.options.classPrefix}--complete`);

    this.fadeOutTimer = setTimeout(() => {
      this.element.classList.remove(`${this.options.classPrefix}--complete`);
      this.element.style.removeProperty('--progress');
    }, this.options.fadeOutDelay);
  }

  /**
   * Reset/cancel progress bar
   */
  reset(): void {
    this.clearFadeOutTimer();
    this.element.classList.remove(`${this.options.classPrefix}--loading`);
    this.element.classList.remove(`${this.options.classPrefix}--complete`);
    this.element.style.removeProperty('--progress');
  }

  /**
   * Check if currently loading
   */
  isLoading(): boolean {
    return this.element.classList.contains(
      `${this.options.classPrefix}--loading`
    );
  }

  private clearFadeOutTimer(): void {
    if (this.fadeOutTimer) {
      clearTimeout(this.fadeOutTimer);
      this.fadeOutTimer = null;
    }
  }
}
