/**
 * BookingManager — owner-side UI for the calendar booking feature
 * (Calendly-style availability on top of NIP-52).
 *
 * Mounted into the Calendar addon view (`data-addon-content="calendar-booking"`)
 * when the calendar is enabled. Lets the owner:
 *   - define weekly availability (per weekday, time window),
 *   - set slot length, buffer, minimum lead time and horizon,
 *   - add/remove vacation date ranges,
 *   - save the config (NIP-78 kind 30078) and rebuild the materialized
 *     kind-31923 slot events (diff → publish/delete),
 *   - see the resulting slots as free/booked (with the guest profile linked),
 *   - copy the public booking page URL.
 *
 * Guest-side flow lives in ProfileBookingView; slot math in bookingSlots.ts.
 */

import { ToastService } from '../../services/ToastService';
import { AuthService } from '../../services/AuthService';
import { UserProfileService } from '../../services/UserProfileService';
import { NnDropdown } from '../../components/ui/NnDropdown';
import { Switch } from '../../components/ui/Switch';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { encodeNpub } from '../../services/NostrToolsAdapter';
import { BookingService, type OwnerSlot } from './BookingService';
import type {
  BookingConfig,
  BookingVacationRange,
} from '../../helpers/nip52/bookingSlots';

const MINUTE = 60_000;
const DAY = 86_400_000;
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function defaultConfig(): BookingConfig {
  return {
    version: 1,
    enabled: false,
    title: '30 minute meeting',
    description: '',
    slotMinutes: 30,
    bufferMinutes: 0,
    minLeadHours: 4,
    horizonDays: 56,
    tzOffsetMinutes: new Date().getTimezoneOffset(),
    week: [
      { enabled: false, startMinute: 540, endMinute: 1080 },
      { enabled: true, startMinute: 540, endMinute: 1080 },
      { enabled: true, startMinute: 540, endMinute: 1080 },
      { enabled: true, startMinute: 540, endMinute: 1080 },
      { enabled: true, startMinute: 540, endMinute: 1080 },
      { enabled: true, startMinute: 540, endMinute: 1080 },
      { enabled: false, startMinute: 540, endMinute: 1080 },
    ],
    vacations: [],
  };
}

/** Owner-local date (YYYY-MM-DD) of a UTC ms timestamp, per config offset. */
function toLocalDateStr(ms: number, tzOffsetMinutes: number): string {
  return new Date(ms - tzOffsetMinutes * MINUTE).toISOString().slice(0, 10);
}

/** UTC ms of owner-local midnight for a YYYY-MM-DD string, per config offset. */
function fromLocalDateStr(dateStr: string, tzOffsetMinutes: number): number {
  return Date.parse(`${dateStr}T00:00:00Z`) + tzOffsetMinutes * MINUTE;
}

function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function timeToMinutes(value: string): number {
  const parts = value.split(':').map(Number);
  const h = parts[0] ?? -1;
  const m = parts[1] ?? 0;
  if (!Number.isFinite(h) || !Number.isFinite(m)) return -1;
  return h * 60 + m;
}

export class BookingManager {
  private element: HTMLElement;
  private config: BookingConfig = defaultConfig();
  private slots: OwnerSlot[] = [];
  /** d-tag of the slot currently being cancelled (busy state). */
  private cancellingDTag: string | null = null;
  private loading = false;
  private destroyed = false;
  /** Staged dropdown selections (written on change, applied on save). */
  private dropdowns: NnDropdown[] = [];
  private enableSwitch: Switch | null = null;

  constructor(slot: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'booking-manager';
    slot.appendChild(this.element);
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.render();
    const pubkey = AuthService.getInstance().getCurrentUser()?.pubkey ?? '';
    if (!pubkey) return;
    const service = BookingService.getInstance();
    const [config, slots] = await Promise.all([
      service.fetchConfigForPubkey(pubkey),
      service.fetchOwnerSlots(pubkey),
    ]);
    if (this.destroyed) return;
    if (config) this.config = config;
    this.slots = slots;
    this.loading = false;
    this.render();
    // Owner device: rebuild booking reminders from the fresh slot state.
    service.rescheduleOwnerReminders();
  }

  /** Re-fetch only the slot list (config stays as locally staged/saved). */
  private async refreshSlots(): Promise<void> {
    const pubkey = AuthService.getInstance().getCurrentUser()?.pubkey ?? '';
    if (!pubkey) return;
    const service = BookingService.getInstance();
    this.slots = await service.fetchOwnerSlots(pubkey);
    if (this.destroyed) return;
    this.loading = false;
    this.render();
    service.rescheduleOwnerReminders();
  }

  private readForm(): BookingConfig | null {
    const root = this.element;
    const value = (sel: string) =>
      (root.querySelector(sel) as HTMLInputElement | null)?.value ?? '';
    const week = this.config.week.map((day, index) => {
      const enabled =
        (
          root.querySelector(
            `[data-day-enabled="${index}"]`
          ) as HTMLInputElement
        )?.checked ?? day.enabled;
      const startMinute =
        timeToMinutes(value(`[data-day-start="${index}"]`)) || day.startMinute;
      const endMinute =
        timeToMinutes(value(`[data-day-end="${index}"]`)) || day.endMinute;
      return {
        enabled,
        startMinute,
        endMinute: Math.max(endMinute, startMinute + 15),
      };
    });
    return {
      ...this.config,
      title:
        value('[data-booking-title]').trim().slice(0, 120) || this.config.title,
      description: value('[data-booking-desc]').trim().slice(0, 1000),
      // Enabled + dropdown values are staged by their onChange handlers.
      week,
      vacations: this.config.vacations,
    };
  }

  private async save(): Promise<void> {
    const config = this.readForm();
    if (!config) return;
    this.config = config;
    const btn = this.element.querySelector(
      '[data-booking-save]'
    ) as HTMLButtonElement | null;
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Publishing…';
    }
    try {
      const service = BookingService.getInstance();
      await service.publishConfig(config);
      const { published, deleted } = await service.rebuildSlots(config);
      ToastService.show(
        config.enabled
          ? `Booking page updated — ${published} slots published, ${deleted} removed`
          : 'Booking page disabled — published slots removed',
        'success'
      );
      // Do NOT re-fetch the config from relays here: propagation lag would
      // hand back the PREVIOUS config (enabled=false) and clobber the state
      // the user just saved, flipping the switch off and deleting the slots
      // on their next save. The just-saved object IS the truth — refresh only
      // the slot list.
      this.config = config;
      await this.refreshSlots();
    } catch (err) {
      ToastService.show(
        `Booking config failed: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      );
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Save & publish slots';
      }
    }
  }

  private addVacation(): void {
    const from = (
      this.element.querySelector('[data-vacation-from]') as HTMLInputElement
    )?.value;
    const to = (
      this.element.querySelector('[data-vacation-to]') as HTMLInputElement
    )?.value;
    if (!from || !to) {
      ToastService.show('Pick a from and to date first', 'info');
      return;
    }
    const startMs = fromLocalDateStr(from, this.config.tzOffsetMinutes);
    // `to` is inclusive in the UI; make the range cover that whole owner-local day.
    const endMs = fromLocalDateStr(to, this.config.tzOffsetMinutes) + DAY;
    if (endMs <= startMs) {
      ToastService.show('The vacation end must be after the start', 'error');
      return;
    }
    const range: BookingVacationRange = { startMs, endMs };
    this.config.vacations = [...this.config.vacations, range].sort(
      (a, b) => a.startMs - b.startMs
    );
    this.renderVacations();
  }

  private render(): void {
    const c = this.config;
    const npub = encodeNpub(
      AuthService.getInstance().getCurrentUser()?.pubkey ?? ''
    );
    const bookingUrl = `${window.location.origin}/profile/${npub}/book`;

    const dayRows = c.week
      .map(
        (day, index) => `
        <div class="booking-manager__day" data-day-row="${index}">
          <label class="nn-checkbox nn-checkbox--label-left nn-checkbox--small booking-manager__day-label">
            <span>${WEEKDAY_LABELS[index]}</span>
            <input type="checkbox" data-day-enabled="${index}" ${day.enabled ? 'checked' : ''} />
          </label>
          <input class="input input--mini" type="time" data-day-start="${index}" value="${minutesToTime(day.startMinute)}" />
          <span class="booking-manager__dash">–</span>
          <input class="input input--mini" type="time" data-day-end="${index}" value="${minutesToTime(day.endMinute)}" />
        </div>`
      )
      .join('');

    const slotList = this.loading
      ? '<div class="pulsate">Loading slots…</div>'
      : this.slots.length === 0
        ? '<p class="form__note">No slots published yet. Save the config to generate them.</p>'
        : `<div class="ui-list">${this.slots
            .map(slot => {
              // Absolute date+time in the viewer's locale — formatTimestamp()
              // is built for past events (relative "1s"/"5m" for anything not
              // yet started).
              const when = new Date(slot.data.startMs).toLocaleString('en-US', {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              });
              // Busy state: deletion/DMs in flight for this slot.
              const cancelling = this.cancellingDTag === slot.data.dTag;
              const booked = cancelling
                ? '<span class="pulsate">Cancelling…</span>'
                : slot.bookedBy
                  ? `<span class="badge badge--green">Booked by ${escapeHtml(
                      UserProfileService.getInstance().getUsername(
                        slot.bookedBy
                      ) || 'guest'
                    )}</span>
                   ${
                     slot.participants.length
                       ? `<span class="badge">+${slot.participants.length}</span>`
                       : ''
                   }
                   <button class="btn btn--passive btn--mini" data-cancel-booking="${escapeHtmlAttr(
                     slot.data.dTag
                   )}">Cancel</button>`
                  : '<span class="badge badge--accent">Free</span>';
              return `<div class="ui-list__item">
                <span>${escapeHtml(when)}</span>
                ${booked}
              </div>`;
            })
            .join('')}</div>`;

    const vacations = c.vacations.length
      ? `<div class="ui-list">${c.vacations
          .map(
            (v, index) => `<div class="ui-list__item">
              <span>${escapeHtml(toLocalDateStr(v.startMs, c.tzOffsetMinutes))} → ${escapeHtml(
                toLocalDateStr(v.endMs - DAY, c.tzOffsetMinutes)
              )}</span>
              <button class="btn btn--passive btn--mini" data-vacation-remove="${index}">Remove</button>
            </div>`
          )
          .join('')}</div>`
      : '<p class="form__note">No vacation ranges.</p>';

    this.element.innerHTML = `
      <h2>Booking page</h2>
      <p class="form__note">
        Let people book appointments in your free time. Your availability is public
        (the slots are regular NIP-52 calendar events); bookings arrive as a private
        message. Page: <a href="/profile/${escapeHtmlAttr(npub)}/book" data-booking-link>${escapeHtmlAttr(bookingUrl)}</a>
        <button class="btn-icon" data-booking-copy title="Copy link">
          <svg width="18" height="18"><use href="#icon-copy-24"/></svg>
        </button>
      </p>
      <div class="form__row form__row--oneline">
        <span class="setting__label">Enable booking page</span>
        <div class="setting__control" data-slot="booking-enabled"></div>
      </div>
      <div class="form__row">
        <label for="booking-title">Appointment title</label>
        <input class="input" id="booking-title" data-booking-title value="${escapeHtmlAttr(c.title)}" maxlength="120" />
      </div>
      <div class="form__row">
        <label for="booking-desc">Description</label>
        <textarea class="textarea textarea--small" id="booking-desc" data-booking-desc maxlength="1000">${escapeHtml(c.description)}</textarea>
      </div>
      <div class="form__row form__row--oneline">
        <label>Slot length</label>
        <div data-slot="dropdown-slot-minutes"></div>
      </div>
      <div class="form__row form__row--oneline">
        <label>Buffer between slots</label>
        <div data-slot="dropdown-buffer"></div>
      </div>
      <div class="form__row form__row--oneline">
        <label>Minimum notice</label>
        <div data-slot="dropdown-lead"></div>
      </div>
      <div class="form__row form__row--oneline">
        <label>Bookable window</label>
        <div data-slot="dropdown-horizon"></div>
      </div>
      <h3>Weekly availability</h3>
      <div class="booking-manager__week">${dayRows}</div>
      <h3>Vacation</h3>
      ${vacations}
      <div class="l-row booking-manager__vacation-add">
        <input class="input datepicker" type="date" data-vacation-from aria-label="Vacation from" />
        <input class="input datepicker" type="date" data-vacation-to aria-label="Vacation to" />
        <button class="btn btn--passive" data-vacation-add>Add</button>
      </div>
      <div class="l-row--right">
        <button class="btn" data-booking-save>Save &amp; publish slots</button>
      </div>
      <h3>Your slots</h3>
      ${slotList}
    `;

    this.wire();
    this.renderEnableSwitch();
    this.renderDropdowns();
    this.wireCancelButtons();
  }

  /** Owner cancels a guest's booking: reason prompt → delete + notify. */
  private async cancelBooking(dTag: string): Promise<void> {
    const slot = this.slots.find(s => s.data.dTag === dTag);
    if (!slot || !slot.bookedBy) return;
    const { ModalService } = await import('../../services/ModalService');
    const reason = await ModalService.getInstance().prompt({
      title: 'Cancel booking',
      message: 'The guest and all participants will be informed by DM.',
      placeholder: 'Reason (optional)',
      multiline: true,
      allowEmpty: true,
      confirmText: 'Cancel booking',
    });
    if (reason === null) return;
    // Busy state on the affected row: pulsating placeholder instead of the
    // booked badge while the deletion + DMs are in flight.
    this.cancellingDTag = dTag;
    this.render();
    const result = await BookingService.getInstance().ownerCancelBooking(
      slot.data,
      reason,
      slot.bookedBy,
      slot.participants
    );
    if (this.destroyed) return;
    if (result.ok) {
      // Optimistic release: the deletion was accepted — free the slot locally
      // right away; the background re-fetch only reconciles.
      slot.bookedBy = null;
      slot.bookedByMe = false;
      slot.participants = [];
      this.cancellingDTag = null;
      this.render();
      ToastService.show(
        result.dmFailures
          ? `${result.detail} — ${result.dmFailures} DM(s) failed`
          : result.detail,
        result.dmFailures ? 'warning' : 'success'
      );
      void this.refreshSlots();
    } else {
      ToastService.show(result.detail, 'error');
      this.cancellingDTag = null;
      this.render();
    }
  }

  private wireCancelButtons(): void {
    this.element
      .querySelectorAll<HTMLElement>('[data-cancel-booking]')
      .forEach(btn =>
        btn.addEventListener('click', () => {
          const dTag = btn.dataset.cancelBooking;
          if (dTag) void this.cancelBooking(dTag);
        })
      );
  }

  /** Enable toggle: staged like the dropdowns, applied on save. */
  private renderEnableSwitch(): void {
    this.enableSwitch?.destroy();
    this.enableSwitch = new Switch({
      label: '',
      checked: this.config.enabled,
      onChange: checked => {
        this.config.enabled = checked;
      },
    });
    const mount = this.element.querySelector(
      '[data-slot="booking-enabled"]'
    ) as HTMLElement | null;
    if (!mount) return;
    mount.innerHTML = this.enableSwitch.render();
    this.enableSwitch.setupEventListeners(mount);
  }

  /** Replace the four settings dropdowns (NnDropdown, staged on change). */
  private renderDropdowns(): void {
    this.dropdowns.forEach(d => d.destroy());
    this.dropdowns = [];

    const specs: Array<{
      selector: string;
      options: Array<{ value: string; label: string }>;
      selected: string;
      apply: (value: string) => void;
    }> = [
      {
        selector: '[data-slot="dropdown-slot-minutes"]',
        options: [15, 20, 30, 45, 60, 90].map(m => ({
          value: String(m),
          label: `${m} minutes`,
        })),
        selected: String(this.config.slotMinutes),
        apply: value => {
          this.config.slotMinutes = Number(value);
        },
      },
      {
        selector: '[data-slot="dropdown-buffer"]',
        options: [0, 5, 10, 15, 30].map(m => ({
          value: String(m),
          label: `${m} minutes`,
        })),
        selected: String(this.config.bufferMinutes),
        apply: value => {
          this.config.bufferMinutes = Number(value);
        },
      },
      {
        selector: '[data-slot="dropdown-lead"]',
        options: [0, 1, 2, 4, 12, 24, 48].map(h => ({
          value: String(h),
          label: `${h} hours`,
        })),
        selected: String(this.config.minLeadHours),
        apply: value => {
          this.config.minLeadHours = Number(value);
        },
      },
      {
        selector: '[data-slot="dropdown-horizon"]',
        options: [14, 28, 56, 90].map(d => ({
          value: String(d),
          label: `${d} days`,
        })),
        selected: String(this.config.horizonDays),
        apply: value => {
          this.config.horizonDays = Number(value);
        },
      },
    ];

    for (const spec of specs) {
      const mount = this.element.querySelector(
        spec.selector
      ) as HTMLElement | null;
      if (!mount) continue;
      const dropdown = new NnDropdown({
        options: spec.options,
        selectedValue: spec.selected,
        width: '100%',
        onChange: value => spec.apply(value),
      });
      mount.appendChild(dropdown.getElement());
      this.dropdowns.push(dropdown);
    }
  }

  private wire(): void {
    const on = (selector: string, event: string, handler: () => void) => {
      this.element.querySelector(selector)?.addEventListener(event, handler);
    };

    on('[data-booking-save]', 'click', () => void this.save());
    on('[data-vacation-add]', 'click', () => this.addVacation());
    on('[data-booking-copy]', 'click', () => {
      const link =
        this.element.querySelector('[data-booking-link]')?.textContent ?? '';
      void navigator.clipboard.writeText(link);
      ToastService.show('Booking page link copied', 'success');
    });

    // Keep the "to" time ahead of the "from" time: when the user moves the
    // start past the current end, bump the end to start + 30 min so a
    // negative/empty window can't be entered by hand.
    this.element.querySelectorAll('[data-day-start]').forEach(input => {
      input.addEventListener('change', () => {
        const startInput = input as HTMLInputElement;
        const endInput = this.element.querySelector(
          `[data-day-end="${startInput.dataset.dayStart}"]`
        ) as HTMLInputElement | null;
        if (!endInput) return;
        const start = timeToMinutes(startInput.value);
        const end = timeToMinutes(endInput.value);
        if (start >= 0 && end <= start) {
          endInput.value = minutesToTime(Math.min(start + 30, 1439));
        }
      });
    });

    this.element.querySelectorAll('[data-vacation-remove]').forEach(btn =>
      btn.addEventListener('click', () => {
        const index = Number((btn as HTMLElement).dataset.vacationRemove);
        this.config.vacations = this.config.vacations.filter(
          (_, i) => i !== index
        );
        this.renderVacations();
      })
    );
  }

  /** Re-render only the vacation block (keeps unsaved form input intact). */
  private renderVacations(): void {
    const row = this.element.querySelector('[data-vacation-list]');
    if (!row) {
      this.render();
      return;
    }
    const tz = this.config.tzOffsetMinutes;
    const vacations = this.config.vacations;
    row.innerHTML = vacations.length
      ? `<div class="ui-list">${vacations
          .map(
            (v, index) => `<div class="ui-list__item">
              <span>${escapeHtml(toLocalDateStr(v.startMs, tz))} → ${escapeHtml(
                toLocalDateStr(v.endMs - DAY, tz)
              )}</span>
              <button class="btn btn--passive btn--mini" data-vacation-remove="${index}">Remove</button>
            </div>`
          )
          .join('')}</div>`
      : '<p class="form__note">No vacation ranges.</p>';
    this.element.querySelectorAll('[data-vacation-remove]').forEach(btn =>
      btn.addEventListener('click', () => {
        const index = Number((btn as HTMLElement).dataset.vacationRemove);
        this.config.vacations = this.config.vacations.filter(
          (_, i) => i !== index
        );
        this.renderVacations();
      })
    );
  }

  public destroy(): void {
    this.destroyed = true;
    this.dropdowns.forEach(d => d.destroy());
    this.dropdowns = [];
    this.element.remove();
  }
}
