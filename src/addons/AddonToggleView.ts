/**
 * AddonToggleView
 *
 * Reusable base View for toggle-only addons (Bookmarks, Tribes, Extended Follows,
 * Wallet Balance). Renders an `<h1>` + a single `.section`/`.setting` block
 * with an enable Switch + description text.
 *
 * Addons with their own settings/content UI should NOT use this — they
 * extend `View` directly and mount their own SettingsSection.
 *
 * Usage:
 *
 * ```ts
 * import { AddonToggleView } from '../AddonToggleView';
 * import { isBookmarksEnabled, setBookmarksEnabled } from './index';
 *
 * export class BookmarksAddonView extends AddonToggleView {
 *   constructor() {
 *     super({
 *       id: 'bookmarks',
 *       name: 'Bookmarks',
 *       description: 'Save notes and links to bookmark folders.',
 *       toggleEvent: 'bookmarks:addon-toggle',
 *       isEnabled: () => isBookmarksEnabled(),
 *       setEnabled: (v) => setBookmarksEnabled(v),
 *     });
 *   }
 * }
 * ```
 */

import { View } from '../components/views/View';
import { Switch } from '../components/ui/Switch';
import { TypedEventBus } from '../core/TypedEventBus';
import type { AppEventName } from '../core/events';
import { ToastService } from '../services/ToastService';
import { escapeHtml } from '../helpers/escapeHtml';

export interface AddonToggleViewOptions {
  /** Addon id (used for view-content class suffix) */
  id: string;
  /** Display name shown in the H1 and toast messages */
  name: string;
  /** One-paragraph description shown under the toggle */
  description: string;
  /** Optional TypedEventBus event emitted on toggle (e.g. 'bookmarks:addon-toggle') */
  toggleEvent?: string;
  /** Synchronous enabled-state read */
  isEnabled: () => boolean;
  /** Synchronous enabled-state write */
  setEnabled: (v: boolean) => void;
}

export class AddonToggleView extends View {
  protected container: HTMLElement;
  private enableSwitch: Switch | null = null;
  private opts: AddonToggleViewOptions;

  constructor(opts: AddonToggleViewOptions) {
    super();
    this.opts = opts;
    this.container = document.createElement('div');
    this.container.className = `view-content view-content--addon view-content--addon-${opts.id}`;
    this.render();
  }

  private render(): void {
    const enabled = this.opts.isEnabled();

    this.enableSwitch = new Switch({
      label: '',
      checked: enabled,
      onChange: checked => {
        this.opts.setEnabled(checked);
        if (this.opts.toggleEvent) {
          TypedEventBus.getInstance().emit(
            this.opts.toggleEvent as AppEventName,
            {
              enabled: checked,
            }
          );
        }
        ToastService.show(
          checked ? `${this.opts.name} enabled` : `${this.opts.name} disabled`,
          'success'
        );
      },
    });

    this.container.innerHTML = `
      <h1>${escapeHtml(this.opts.name)}</h1>
      <section class="section">
        <div class="setting">
          <span class="setting__label">Enable ${escapeHtml(this.opts.name)}</span>
          <div class="setting__control">${this.enableSwitch.render()}</div>
          <p class="setting__desc">${escapeHtml(this.opts.description)}</p>
        </div>
      </section>
    `;
    this.enableSwitch.setupEventListeners(this.container);
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.enableSwitch?.destroy();
    this.enableSwitch = null;
    this.container.innerHTML = '';
  }
}
