/**
 * CalendarAddonView - settings page + inline grid (route `/addons/calendar`).
 *
 * Toggle (emits `calendar:addon-toggle`). When enabled, the calendar grid is
 * rendered directly below the toggle — no separate full-screen route.
 * Create/edit arrives in phase 2, private encrypted events in phase 3.
 */

import { View } from '../../components/views/View';
import { Switch } from '../../components/ui/Switch';
import { TypedEventBus } from '../../core/TypedEventBus';
import { ToastService } from '../../services/ToastService';
import { AuthService } from '../../services/AuthService';
import { isCalendarEnabled, setCalendarEnabled } from './index';
import { CalendarGridView } from './CalendarGridView';

export class CalendarAddonView extends View {
  private container: HTMLElement;
  private enableSwitch: Switch | null = null;
  private grid: CalendarGridView | null = null;

  constructor() {
    super();
    this.container = document.createElement('div');
    this.container.className =
      'view-content view-content--addon view-content--addon-calendar';
    this.render();
  }

  private render(): void {
    this.enableSwitch = new Switch({
      label: '',
      checked: isCalendarEnabled(),
      onChange: checked => {
        setCalendarEnabled(checked);
        TypedEventBus.getInstance().emit('calendar:addon-toggle', {
          enabled: checked,
        });
        ToastService.show(
          checked ? 'Calendar enabled' : 'Calendar disabled',
          'success'
        );
        this.renderGrid();
      },
    });

    this.container.innerHTML = `
      <h1>Calendar</h1>
      <section class="section">
        <div class="setting">
          <span class="setting__label">Enable Calendar</span>
          <div class="setting__control">${this.enableSwitch.render()}</div>
          <p class="setting__desc">NIP-52 calendar for Nostr: month, week and list views over your public events (kinds 31922/31923), calendar collections (kind 31924) and RSVPs (kind 31925). Private encrypted events are planned.</p>
        </div>
      </section>
      <div data-addon-content="calendar-grid"></div>
    `;
    this.enableSwitch.setupEventListeners(this.container);
    this.renderGrid();
  }

  /** Mount the grid inline when enabled; tear it down when disabled. */
  private renderGrid(): void {
    const slot = this.container.querySelector(
      '[data-addon-content="calendar-grid"]'
    ) as HTMLElement | null;
    if (!slot) return;

    const npub = AuthService.getInstance().getCurrentUser()?.npub ?? '';
    const shouldShow = isCalendarEnabled() && !!npub;

    if (!shouldShow) {
      this.grid?.destroy();
      this.grid = null;
      slot.innerHTML = '';
      return;
    }

    if (this.grid) return; // already mounted
    this.grid = new CalendarGridView();
    slot.appendChild(this.grid.getElement());
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.grid?.destroy();
    this.grid = null;
    this.enableSwitch?.destroy();
    this.enableSwitch = null;
    this.container.innerHTML = '';
  }
}
