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
import { CustomDropdown } from '../../components/ui/CustomDropdown';
import {
  setupTabClickHandlers,
  switchTabWithContent,
} from '../../helpers/TabsHelper';
import { isCalendarEnabled, setCalendarEnabled } from './index';
import { CalendarGridView } from './CalendarGridView';
import { BookingManager } from './BookingManager';
import {
  CalendarReminderService,
  LEAD_OPTIONS,
} from './CalendarReminderService';

export class CalendarAddonView extends View {
  private container: HTMLElement;
  private enableSwitch: Switch | null = null;
  private leadDropdown: CustomDropdown | null = null;
  private grid: CalendarGridView | null = null;
  private bookingManager: BookingManager | null = null;

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
          <p class="setting__desc">Your personal calendar on Nostr: keep your own appointments in month, week and list views, subscribe to public event calendars you're interested in, and add private events that only you can see. With reminders — and when you join someone's event, you can let them know you're coming.</p>
        </div>
        <div class="setting">
          <span class="setting__label">Remind me before events start</span>
          <div class="setting__control" data-slot="reminder-lead"></div>
          <p class="setting__desc">Default reminder lead for all events. Reminders stay local to this device — nothing is published. Single events can override this in their editor.</p>
        </div>
      </section>
      <div class="tabs" data-el="calendar-tabs">
        <button class="tab tab--active" data-tab="personal">Personal calendar</button>
        <button class="tab" data-tab="booking">Booking Calendar</button>
      </div>
      <div class="tab-content tab-content--active" data-tab-content="personal">
        <div data-addon-content="calendar-grid"></div>
      </div>
      <div class="tab-content" data-tab-content="booking">
        <div data-addon-content="calendar-booking"></div>
      </div>
    `;
    this.enableSwitch.setupEventListeners(this.container);
    this.renderLeadDropdown();
    setupTabClickHandlers(this.container, tabId =>
      switchTabWithContent(this.container, tabId)
    );
    this.renderGrid();
    this.renderBooking();
  }

  /** Reminder default lead: applies to every event without its own override. */
  private renderLeadDropdown(): void {
    const slot = this.container.querySelector(
      '[data-slot="reminder-lead"]'
    ) as HTMLElement | null;
    if (!slot) return;
    this.leadDropdown?.destroy();
    const service = CalendarReminderService.getInstance();
    this.leadDropdown = new CustomDropdown({
      options: LEAD_OPTIONS,
      selectedValue: String(service.getDefaultLeadMin()),
      width: '100%',
      onChange: value => {
        service.setDefaultLeadMin(Number(value));
        ToastService.show('Reminder default updated', 'success');
      },
    });
    slot.appendChild(this.leadDropdown.getElement());
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

  /** Mount the booking manager inline when enabled; tear down when disabled. */
  private renderBooking(): void {
    const slot = this.container.querySelector(
      '[data-addon-content="calendar-booking"]'
    ) as HTMLElement | null;
    if (!slot) return;

    const npub = AuthService.getInstance().getCurrentUser()?.npub ?? '';
    const shouldShow = isCalendarEnabled() && !!npub;

    if (!shouldShow) {
      this.bookingManager?.destroy();
      this.bookingManager = null;
      slot.innerHTML = '';
      return;
    }

    if (this.bookingManager) return; // already mounted
    this.bookingManager = new BookingManager(slot);
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.grid?.destroy();
    this.grid = null;
    this.bookingManager?.destroy();
    this.bookingManager = null;
    this.enableSwitch?.destroy();
    this.enableSwitch = null;
    this.leadDropdown?.destroy();
    this.leadDropdown = null;
    this.container.innerHTML = '';
  }
}
