/**
 * AlertBarService - generic top-of-app alert bar.
 *
 * A reusable UI pattern: a thin bar at the very top of the app that pushes the
 * rest of the content down (it is a real flow child of #app, not an overlay).
 * Features queue alerts via show(); they display one at a time. Core, generic,
 * dormant until shown. Addons/features drive it (e.g. note reminders).
 *
 * @service AlertBarService
 */

import { escapeHtml } from '../helpers/escapeHtml';

export interface AlertBarSnoozeOption {
  label: string;
  minutes: number;
}

export interface AlertBarConfig {
  /** Main text (left column). Truncated in the UI. */
  text: string;
  /** Click on the text (e.g. navigate to the source). */
  onTextClick?: () => void;
  /** Primary "Ok" link - acknowledge and dismiss. */
  onOk: () => void;
  /** Snooze options for the "Notify again in" pulldown. */
  snoozeOptions?: AlertBarSnoozeOption[];
  /** Called with the chosen snooze minutes. */
  onSnooze?: (minutes: number) => void;
}

const DEFAULT_SNOOZE: AlertBarSnoozeOption[] = [
  { label: '5 min', minutes: 5 },
  { label: '15 min', minutes: 15 },
  { label: '30 min', minutes: 30 },
  { label: '60 min', minutes: 60 },
  { label: '180 min', minutes: 180 },
];

export class AlertBarService {
  private static instance: AlertBarService;
  private queue: AlertBarConfig[] = [];
  private barEl: HTMLElement | null = null;
  private outsideClick: ((e: MouseEvent) => void) | null = null;

  public static getInstance(): AlertBarService {
    if (!AlertBarService.instance) {
      AlertBarService.instance = new AlertBarService();
    }
    return AlertBarService.instance;
  }

  /** Enqueue an alert; shows immediately if nothing is currently displayed. */
  public show(config: AlertBarConfig): void {
    this.queue.push(config);
    if (!this.barEl) this.render();
  }

  /** Dismiss the current alert and show the next queued one (if any). */
  private next(): void {
    this.queue.shift();
    this.teardown();
    if (this.queue.length > 0) this.render();
  }

  private render(): void {
    const config = this.queue[0];
    if (!config) return;
    const app = document.getElementById('app');
    if (!app) return;

    const snooze = config.snoozeOptions ?? DEFAULT_SNOOZE;
    const bar = document.createElement('div');
    bar.className = 'alert-bar';
    bar.innerHTML = `
      <div class="alert-bar__inner l-spread">
        <span class="alert-bar__text" data-text>${escapeHtml(config.text)}</span>
        <div class="alert-bar__actions">
          <a class="alert-bar__link" data-ok role="button" tabindex="0">Ok</a>
          ${config.onSnooze ? `
          <div class="alert-bar__snooze">
            <a class="alert-bar__link" data-snooze-toggle role="button" tabindex="0">Notify again in &#9662;</a>
            <div class="alert-bar__snooze-menu" data-snooze-menu hidden>
              ${snooze.map((o) => `<a class="alert-bar__snooze-option" role="button" tabindex="0" data-min="${o.minutes}">${escapeHtml(o.label)}</a>`).join('')}
            </div>
          </div>` : ''}
        </div>
      </div>
    `;

    // Text click -> source.
    if (config.onTextClick) {
      const textEl = bar.querySelector('[data-text]') as HTMLElement;
      textEl.classList.add('alert-bar__text--clickable');
      textEl.addEventListener('click', () => config.onTextClick?.());
    }

    // Ok.
    bar.querySelector('[data-ok]')?.addEventListener('click', () => {
      config.onOk();
      this.next();
    });

    // Snooze pulldown.
    const toggle = bar.querySelector('[data-snooze-toggle]') as HTMLElement | null;
    const menu = bar.querySelector('[data-snooze-menu]') as HTMLElement | null;
    if (toggle && menu) {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.hidden = !menu.hidden;
      });
      menu.querySelectorAll('[data-min]').forEach((opt) => {
        opt.addEventListener('click', () => {
          const minutes = Number((opt as HTMLElement).dataset.min);
          config.onSnooze?.(minutes);
          this.next();
        });
      });
      this.outsideClick = () => { menu.hidden = true; };
      document.addEventListener('click', this.outsideClick);
    }

    app.insertBefore(bar, app.firstChild);
    this.barEl = bar;
    // Expose the (dynamic, mobile-stacked) bar height so the fixed mobile header
    // can sit below the bar instead of overlapping it.
    document.documentElement.style.setProperty('--alert-bar-h', `${bar.offsetHeight}px`);
  }

  private teardown(): void {
    if (this.outsideClick) {
      document.removeEventListener('click', this.outsideClick);
      this.outsideClick = null;
    }
    this.barEl?.remove();
    this.barEl = null;
    document.documentElement.style.removeProperty('--alert-bar-h');
  }
}
