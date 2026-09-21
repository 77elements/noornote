/**
 * ProfileBookingView — public booking page at `/profile/:npub/book`.
 *
 * Weekly calendar view of an owner's bookable slots (NIP-52 kind-31923
 * events with t=booking): the visitor flips through weeks (Previous/Next
 * week + week dots in the `.nn-pager` pattern) and books a free slot
 * — accepted RSVP (public, collision protection) + NIP-17 DM to the owner
 * with the summary. Guest name/note live ONLY in the DM.
 *
 * Logged-out visitors can browse; booking triggers the standard AuthGuard
 * login redirect. Config missing or disabled → friendly state.
 */

import { View } from './View';
import { Router } from '../../services/Router';
import { AuthGuard } from '../../services/AuthGuard';
import { UserProfileService } from '../../services/UserProfileService';
import { ToastService } from '../../services/ToastService';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { downloadCalendarEventICS } from '../../helpers/nip52/icsExport';
import { extractMentionPubkeysFromText } from '../../helpers/nip19';
import { MentionAutocomplete } from '../mentions/MentionAutocomplete';
import type { BookingConfig } from '../../helpers/nip52/bookingSlots';
import type { CalendarEventData } from '../../helpers/nip52/parser';
import type { OwnerSlot } from '../../addons/calendar/BookingService';

const DAY_MS = 86_400_000;
const TIME_LOCALE = 'en-US';

interface WeekDayCell {
  /** Visitor-local day start (midnight). */
  dayStartMs: number;
  weekdayLabel: string;
  dayNumber: number;
  slots: OwnerSlot[];
  isToday: boolean;
}

export class ProfileBookingView extends View {
  private container: HTMLElement;
  private notFound = false;
  private config: BookingConfig | null = null;
  private ownerPubkey = '';
  /** ALL slots (free + booked) — booked ones render as plain text. */
  private slots: OwnerSlot[] = [];
  /** d-tag of the slot currently selected (form shown below the grid). */
  private selectedDTag: string | null = null;
  private booking = false;
  private bookedSlot: CalendarEventData | null = null;
  private destroyed = false;
  private participantAutocomplete: MentionAutocomplete | null = null;
  /** Page index into `weekStarts()`. */
  private weekIndex = 0;
  /** d-tag of the own booked slot currently showing its cancel form. */
  private cancelDTag: string | null = null;
  /** d-tag of the slot currently being cancelled/booked (busy state). */
  private cancellingDTag: string | null = null;
  private bookingDTag: string | null = null;
  /** Session-local: own bookings cancelled in this session (relay lag guard). */
  private cancelledDTags = new Set<string>();

  constructor(private npub: string) {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--profile-booking';
    this.renderLoading();
    void this.load();
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.destroyed = true;
    this.participantAutocomplete?.destroy();
    this.participantAutocomplete = null;
    this.container.innerHTML = '';
  }

  private async load(): Promise<void> {
    // Accept both npub/nprofile (bech32) and raw 64-hex pubkeys in the URL —
    // hex URLs exist from older links.
    let ownerPubkey = '';
    if (/^[0-9a-fA-F]{64}$/.test(this.npub)) {
      ownerPubkey = this.npub.toLowerCase();
    } else {
      try {
        const decoded = (
          await import('../../services/NostrToolsAdapter')
        ).decodeNip19(this.npub);
        if (decoded.type === 'npub') {
          ownerPubkey = String(decoded.data);
        } else if (decoded.type === 'nprofile') {
          ownerPubkey = String(
            (decoded.data as { pubkey?: string }).pubkey ?? ''
          );
        }
      } catch {
        ownerPubkey = '';
      }
    }
    if (!ownerPubkey) {
      this.notFound = true;
      this.render();
      return;
    }
    this.ownerPubkey = ownerPubkey;

    const { BookingService } = await import(
      '../../addons/calendar/BookingService'
    );
    const service = BookingService.getInstance();
    const config = await service.fetchConfigForPubkey(ownerPubkey);
    if (this.destroyed) return;
    this.config = config;
    if (!config?.enabled) {
      this.notFound = true;
      this.render();
      return;
    }

    const slots = await service.fetchOwnerSlots(ownerPubkey);
    if (this.destroyed) return;
    this.slots = slots;
    this.render();
  }

  // ========== Week helpers (visitor-local, Monday-start weeks) ==========

  private weekStartMs(ms: number): number {
    const d = new Date(ms);
    const mondayOffset = (d.getDay() + 6) % 7;
    return (
      d.getTime() -
      mondayOffset * DAY_MS -
      d.getHours() * 3_600_000 -
      d.getMinutes() * 60_000 -
      d.getSeconds() * 1000
    );
  }

  /** Distinct weeks (Mon-start) that contain free slots, ascending. */
  private weekStarts(): number[] {
    const set = new Set<number>();
    this.slots.forEach(s => set.add(this.weekStartMs(s.data.startMs)));
    return [...set].sort((a, b) => a - b);
  }

  /** All 7 days of the week starting at `weekStartMs` with their free slots. */
  private weekDays(weekStartMs: number): WeekDayCell[] {
    const today = new Date();
    const todayStart = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate()
    ).getTime();
    return Array.from({ length: 7 }, (_, i) => {
      const dayStartMs = weekStartMs + i * DAY_MS;
      const date = new Date(dayStartMs);
      return {
        dayStartMs,
        weekdayLabel: date.toLocaleDateString(TIME_LOCALE, {
          weekday: 'short',
        }),
        dayNumber: date.getDate(),
        slots: this.slots.filter(
          s =>
            s.data.startMs >= dayStartMs && s.data.startMs < dayStartMs + DAY_MS
        ),
        isToday: dayStartMs === todayStart,
      };
    });
  }

  // ========== Rendering ==========

  private renderLoading(): void {
    this.container.innerHTML =
      '<h1>Book a meeting</h1><div class="pulsate">Loading availability…</div>';
  }

  private render(): void {
    if (this.bookedSlot) {
      this.renderSuccess();
      return;
    }

    const ownerName =
      UserProfileService.getInstance().getUsername(this.ownerPubkey) ||
      'this user';

    if (this.notFound || !this.config) {
      this.container.innerHTML = `
        <h1>Book a meeting</h1>
        <p class="form__note">
          ${escapeHtml(ownerName)} does not offer a booking page right now.
        </p>
        <div class="l-row--right"><button class="btn btn--passive" data-back>Back to profile</button></div>
      `;
      this.container
        .querySelector('[data-back]')
        ?.addEventListener('click', () =>
          Router.getInstance().navigate(`/profile/${this.npub}`)
        );
      return;
    }

    const weekStarts = this.weekStarts();
    this.weekIndex = Math.min(
      Math.max(this.weekIndex, 0),
      Math.max(weekStarts.length - 1, 0)
    );

    const nav = `
      <div class="nn-pager">
        <button class="btn-icon" type="button" data-week-prev ${
          this.weekIndex === 0 ? 'disabled' : ''
        } aria-label="Previous week">
          <svg width="18" height="18"><use href="#icon-caret-left"/></svg>
        </button>
        <div class="nn-pager__content">
          ${weekStarts.length > 0 ? escapeHtml(this.weekRangeLabel(weekStarts[this.weekIndex]!)) : ''}
        </div>
        <button class="btn-icon" type="button" data-week-next ${
          this.weekIndex >= weekStarts.length - 1 ? 'disabled' : ''
        } aria-label="Next week">
          <svg width="18" height="18"><use href="#icon-caret-right"/></svg>
        </button>
      </div>
    `;

    const grid =
      weekStarts.length > 0
        ? `<div class="profile-booking__week">${this.weekDays(
            weekStarts[this.weekIndex]!
          )
            .map(day => this.renderDayCell(day))
            .join('')}</div>`
        : '<p class="form__note">No open slots at the moment — check back later.</p>';

    const selectedSlot = this.slots.find(
      s => s.data.dTag === this.selectedDTag && !s.bookedBy
    );

    this.container.innerHTML = `
      <h1>Book a meeting with ${escapeHtml(ownerName)}</h1>
      ${
        this.config.title
          ? `<p class="profile-booking__title">${escapeHtml(this.config.title)}</p>`
          : ''
      }
      ${
        this.config.description
          ? `<p class="profile-booking__desc">${escapeHtml(this.config.description)}</p>`
          : ''
      }
      <p class="form__note">times shown in your local timezone</p>
      ${nav}
      ${grid}
      ${selectedSlot ? this.renderBookingForm(selectedSlot.data) : ''}
      <div class="l-row--right"><button class="btn btn--passive" data-back>Back to profile</button></div>
    `;

    this.wireNav(weekStarts);
    this.wireSlotButtons();
    this.wireCancelLinks();
    if (selectedSlot) this.wireBookingForm(selectedSlot.data);
    this.container
      .querySelector('[data-back]')
      ?.addEventListener('click', () =>
        Router.getInstance().navigate(`/profile/${this.npub}`)
      );
  }

  private weekRangeLabel(weekStartMs: number): string {
    const start = new Date(weekStartMs);
    const end = new Date(weekStartMs + 6 * DAY_MS);
    const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
    return `${start.toLocaleDateString(TIME_LOCALE, opts)} – ${end.toLocaleDateString(
      TIME_LOCALE,
      { ...opts, year: 'numeric' }
    )}`;
  }

  private renderDayCell(day: WeekDayCell): string {
    const entries = day.slots
      .map(slot => {
        const time = new Date(slot.data.startMs).toLocaleTimeString(
          TIME_LOCALE,
          { hour: '2-digit', minute: '2-digit', hour12: false }
        );
        // Busy states: the slot currently being cancelled or booked.
        if (this.cancellingDTag === slot.data.dTag) {
          return `<span class="pulsate profile-booking__slot-pending">Cancelling…</span>`;
        }
        if (this.bookingDTag === slot.data.dTag) {
          return `<span class="pulsate profile-booking__slot-pending">Booking…</span>`;
        }
        // Booked by someone else: plain text, not clickable.
        if (slot.bookedBy && !slot.bookedByMe) {
          return `<span class="profile-booking__slot-booked">${escapeHtml(time)}</span>`;
        }
        // Own booking: text + cancel affordance (reason form on demand).
        if (slot.bookedByMe) {
          if (this.cancelDTag === slot.data.dTag) {
            return `
            <div class="profile-booking__cancel-form">
              <input class="input input--mini" data-cancel-reason placeholder="Reason (optional)" maxlength="200" />
              <div class="profile-booking__cancel-actions">
                <button class="btn btn--mini" data-cancel-confirm="${escapeHtmlAttr(slot.data.dTag)}">Confirm</button>
                <button class="btn btn--passive btn--mini" data-cancel-abort>Keep</button>
              </div>
            </div>`;
          }
          return `<span class="profile-booking__slot-booked"><span>${escapeHtml(time)}</span>
            <a href="#" class="profile-booking__cancel-link" data-cancel-booked="${escapeHtmlAttr(slot.data.dTag)}">Cancel</a></span>`;
        }
        const selected = this.selectedDTag === slot.data.dTag;
        return `<a href="#" class="profile-booking__slot-link${
          selected ? ' profile-booking__slot-link--selected' : ''
        }" data-book="${escapeHtmlAttr(slot.data.dTag)}">${escapeHtml(time)}</a>`;
      })
      .join('');
    return `
      <div class="profile-booking__day ${day.slots.length === 0 ? 'profile-booking__day--empty' : ''}">
        <div class="profile-booking__day-head">
          <span>${escapeHtml(day.weekdayLabel)}</span>
          <strong class="${day.isToday ? 'profile-booking__today' : ''}">${day.dayNumber}</strong>
        </div>
        <div class="profile-booking__day-slots">${entries}</div>
      </div>
    `;
  }

  private wireNav(weekStarts: number[]): void {
    this.container
      .querySelector('[data-week-prev]')
      ?.addEventListener('click', () => {
        if (this.weekIndex > 0) {
          this.weekIndex--;
          this.selectedDTag = null;
          this.render();
        }
      });
    this.container
      .querySelector('[data-week-next]')
      ?.addEventListener('click', () => {
        if (this.weekIndex < weekStarts.length - 1) {
          this.weekIndex++;
          this.selectedDTag = null;
          this.render();
        }
      });
    this.container
      .querySelectorAll<HTMLElement>('[data-week-dot]')
      .forEach(dot =>
        dot.addEventListener('click', () => {
          const index = Number(dot.dataset.weekDot);
          if (index !== this.weekIndex) {
            this.weekIndex = index;
            this.selectedDTag = null;
            this.render();
          }
        })
      );
  }

  private wireSlotButtons(): void {
    this.container
      .querySelectorAll<HTMLAnchorElement>('a[data-book]')
      .forEach(link =>
        link.addEventListener('click', e => {
          e.preventDefault();
          if (!AuthGuard.requireAuth('book an appointment')) return;
          const dTag = link.dataset.book ?? null;
          this.selectedDTag = dTag === this.selectedDTag ? null : dTag;
          this.render();
        })
      );
  }

  /** Own-booked slot: open the inline cancel form (reason + confirm). */
  private wireCancelLinks(): void {
    this.container
      .querySelectorAll<HTMLAnchorElement>('a[data-cancel-booked]')
      .forEach(link =>
        link.addEventListener('click', e => {
          e.preventDefault();
          this.cancelDTag = link.dataset.cancelBooked ?? null;
          this.render();
        })
      );
    this.container
      .querySelectorAll<HTMLElement>('[data-cancel-confirm]')
      .forEach(btn =>
        btn.addEventListener('click', () => {
          const dTag = btn.dataset.cancelConfirm ?? '';
          const slot = this.slots.find(s => s.data.dTag === dTag);
          const reason =
            (
              this.container.querySelector(
                '[data-cancel-reason]'
              ) as HTMLInputElement | null
            )?.value ?? '';
          if (slot) void this.confirmCancel(slot, reason);
        })
      );
    this.container
      .querySelectorAll<HTMLElement>('[data-cancel-abort]')
      .forEach(btn =>
        btn.addEventListener('click', () => {
          this.cancelDTag = null;
          this.render();
        })
      );
  }

  /** Guest cancellation: declined RSVP + cleanup + notifications. */
  private async confirmCancel(slot: OwnerSlot, reason: string): Promise<void> {
    this.cancellingDTag = slot.data.dTag;
    this.render();
    const { BookingService } = await import(
      '../../addons/calendar/BookingService'
    );
    const result = await BookingService.getInstance().cancelBooking(
      slot.data,
      reason
    );
    if (this.destroyed) return;
    if (result.ok) {
      this.cancelledDTags.add(slot.data.dTag);
      this.cancelDTag = null;
      this.cancellingDTag = null;
      this.render();
      ToastService.show(
        result.dmFailures
          ? `${result.detail} — ${result.dmFailures} DM(s) failed`
          : result.detail,
        result.dmFailures ? 'warning' : 'success'
      );
    } else {
      ToastService.show(result.detail, 'error');
      this.cancellingDTag = null;
      this.render();
    }
  }

  private renderBookingForm(slot: CalendarEventData): string {
    const when = new Date(slot.startMs).toLocaleString(TIME_LOCALE, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return `
      <div class="profile-booking__form" data-booking-form>
        <p class="profile-booking__form-title">
          Selected: <strong>${escapeHtml(slot.title)}</strong> — ${escapeHtml(when)}
        </p>
        <div class="form__row">
          <label for="booking-name">Your name (optional)</label>
          <input class="input" id="booking-name" data-form-name maxlength="80" />
        </div>
        <div class="form__row">
          <label for="booking-note">Note for ${escapeHtml(
            UserProfileService.getInstance().getUsername(this.ownerPubkey) ||
              'the host'
          )} (optional, sent as a private message)</label>
          <textarea class="textarea textarea--small" id="booking-note" data-form-note maxlength="500"></textarea>
        </div>
        <div class="form__row">
          <label for="booking-participants">Additional participants (optional)</label>
          <input class="input" id="booking-participants" data-participants-input maxlength="2000"
            placeholder="Tag with @, separate multiple participants with commas" />
          <p class="form__note">
            Nostr users taking part in the meeting — they receive a private
            message about this booking.
          </p>
        </div>
        <div class="l-row--end-pair">
          <button class="btn btn--passive" data-cancel-book>Cancel</button>
          <button class="btn" data-confirm-book ${this.booking ? 'disabled' : ''}>
            ${this.booking ? 'Booking…' : 'Confirm booking'}
          </button>
        </div>
      </div>
    `;
  }

  private wireBookingForm(slot: CalendarEventData): void {
    const form = this.container.querySelector(
      '[data-booking-form]'
    ) as HTMLElement | null;
    if (!form) return;

    form.querySelector('[data-cancel-book]')?.addEventListener('click', () => {
      this.selectedDTag = null;
      this.render();
    });

    form.querySelector('[data-confirm-book]')?.addEventListener('click', () => {
      const name =
        (form.querySelector('[data-form-name]') as HTMLInputElement | null)
          ?.value ?? '';
      const note =
        (form.querySelector('[data-form-note]') as HTMLTextAreaElement | null)
          ?.value ?? '';
      const participantsInput =
        (
          form.querySelector(
            '[data-participants-input]'
          ) as HTMLInputElement | null
        )?.value ?? '';
      void this.confirmBooking(slot, name, note, participantsInput);
    });

    // @-tagging, same as the note composer: typing @ + a few characters shows
    // the candidate list; selection inserts the mention.
    this.participantAutocomplete?.destroy();
    this.participantAutocomplete = new MentionAutocomplete({
      textareaSelector: '[data-participants-input]',
      onMentionInserted: () => {},
    });
    this.participantAutocomplete.init();
  }

  private async confirmBooking(
    slot: CalendarEventData,
    guestName: string,
    note: string,
    participantsInput: string
  ): Promise<void> {
    this.booking = true;
    this.bookingDTag = slot.dTag;
    this.render();
    const { BookingService } = await import(
      '../../addons/calendar/BookingService'
    );
    // Participants are the @-mentions / npubs typed into the field
    // (comma-separated). Established extractor — URL-embedded npubs stay out.
    const participants = extractMentionPubkeysFromText(participantsInput);
    const result = await BookingService.getInstance().bookSlot(
      slot,
      guestName,
      note,
      participants
    );
    if (this.destroyed) return;
    if (!result.ok) {
      ToastService.show(result.detail, 'error');
    } else {
      this.bookedSlot = slot;
    }
    this.booking = false;
    this.bookingDTag = null;
    this.render();
  }

  private renderSuccess(): void {
    const slot = this.bookedSlot;
    if (!slot) return;
    const when = new Date(slot.startMs).toLocaleString(TIME_LOCALE, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    this.container.innerHTML = `
      <h1>Booked!</h1>
      <p class="profile-booking__desc">
        <strong>${escapeHtml(slot.title)}</strong><br />
        ${escapeHtml(when)}
      </p>
      <p class="form__note">
        The host received your booking as a private message. Add it to your
        calendar so you don't forget:
      </p>
      <div class="l-row">
        <button class="btn btn--passive" data-ics>Add to calendar (.ics)</button>
        <button class="btn btn--passive" data-done>Done</button>
      </div>
    `;
    this.container
      .querySelector('[data-ics]')
      ?.addEventListener('click', () => downloadCalendarEventICS(slot));
    this.container
      .querySelector('[data-done]')
      ?.addEventListener('click', () =>
        Router.getInstance().navigate(`/profile/${this.npub}`)
      );
  }
}
