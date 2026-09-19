/**
 * ProfileBookingView — public booking page at `/profile/:npub/book`.
 *
 * Shows an owner's bookable slots (NIP-52 kind-31923 events with t=booking,
 * published by the calendar booking feature) and lets a signed-in visitor
 * book one: accepted RSVP (public, collision protection) + NIP-17 DM to the
 * owner with a summary. Guest name/note live ONLY in the DM.
 *
 * Logged-out visitors can browse slots; booking triggers the standard
 * AuthGuard login redirect. Config missing or disabled → friendly state.
 */

import { View } from './View';
import { Router } from '../../services/Router';
import { AuthGuard } from '../../services/AuthGuard';
import { UserProfileService } from '../../services/UserProfileService';
import { ToastService } from '../../services/ToastService';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { downloadCalendarEventICS } from '../../helpers/nip52/icsExport';
import type { BookingConfig } from '../../helpers/nip52/bookingSlots';
import type { CalendarEventData } from '../../helpers/nip52/parser';
import type { OwnerSlot } from '../../addons/calendar/BookingService';

interface DateGroup {
  /** Visitor-local date label, e.g. "Mon, Sep 21". */
  label: string;
  /** Sort key (UTC ms of the day's first slot). */
  dayStartMs: number;
  slots: OwnerSlot[];
}

export class ProfileBookingView extends View {
  private container: HTMLElement;
  private notFound = false;
  private config: BookingConfig | null = null;
  private ownerPubkey = '';
  private freeSlots: OwnerSlot[] = [];
  /** d-tag of the slot currently showing its booking form, if any. */
  private selectedDTag: string | null = null;
  private booking = false;
  private bookedSlot: CalendarEventData | null = null;
  private destroyed = false;

  constructor(private npub: string) {
    super();
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--profile-booking';
    this.renderLoading();
    void this.load();
  }

  private async load(): Promise<void> {
    let ownerPubkey = '';
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
      this.notFound = true;
      this.render();
      return;
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
    this.freeSlots = slots.filter(s => !s.bookedBy);
    this.render();
  }

  /** Group free slots by the visitor's local calendar day. */
  private dateGroups(): DateGroup[] {
    const groups = new Map<string, DateGroup>();
    for (const slot of this.freeSlots) {
      const date = new Date(slot.data.startMs);
      const key = date.toDateString();
      let group = groups.get(key);
      if (!group) {
        group = {
          label: date.toLocaleDateString(undefined, {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
          }),
          dayStartMs: slot.data.startMs,
          slots: [],
        };
        groups.set(key, group);
      }
      group.slots.push(slot);
    }
    return [...groups.values()].sort((a, b) => a.dayStartMs - b.dayStartMs);
  }

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

    const groups = this.dateGroups();
    const body = groups.length
      ? groups
          .map(
            group => `
        <h2>${escapeHtml(group.label)}</h2>
        <div class="ui-list">
          ${group.slots
            .map(slot => {
              const time = new Date(slot.data.startMs).toLocaleTimeString(
                undefined,
                { hour: '2-digit', minute: '2-digit' }
              );
              const isSelected = this.selectedDTag === slot.data.dTag;
              return `
              <div class="ui-list__item profile-booking__slot">
                <span class="profile-booking__time">${escapeHtml(time)}</span>
                ${
                  isSelected
                    ? this.renderForm(slot)
                    : `<button class="btn btn--passive btn--mini" data-book="${escapeHtmlAttr(
                        slot.data.dTag
                      )}">Book</button>`
                }
              </div>`;
            })
            .join('')}
        </div>`
          )
          .join('')
      : '<p class="form__note">No open slots at the moment — check back later.</p>';

    this.container.innerHTML = `
      <h1>${escapeHtml(this.config.title || 'Book a meeting')}</h1>
      ${
        this.config.description
          ? `<p class="profile-booking__desc">${escapeHtml(this.config.description)}</p>`
          : ''
      }
      <p class="form__note">with ${escapeHtml(ownerName)} · times shown in your local timezone</p>
      ${body}
      <div class="l-row--right"><button class="btn btn--passive" data-back>Back to profile</button></div>
    `;

    this.container
      .querySelector('[data-back]')
      ?.addEventListener('click', () =>
        Router.getInstance().navigate(`/profile/${this.npub}`)
      );

    this.container
      .querySelectorAll<HTMLButtonElement>('[data-book]')
      .forEach(btn =>
        btn.addEventListener('click', () => {
          if (!AuthGuard.requireAuth('book an appointment')) return;
          this.selectedDTag = btn.dataset.book ?? null;
          this.render();
        })
      );

    this.wireForm();
  }

  private renderForm(slot: OwnerSlot): string {
    return `
      <div class="profile-booking__form" data-booking-form="${escapeHtmlAttr(slot.data.dTag)}">
        <div class="form__row">
          <label for="booking-name-${escapeHtmlAttr(slot.data.dTag)}">Your name (optional)</label>
          <input class="input" id="booking-name-${escapeHtmlAttr(slot.data.dTag)}" data-form-name maxlength="80" />
        </div>
        <div class="form__row">
          <label for="booking-note-${escapeHtmlAttr(slot.data.dTag)}">Note for ${escapeHtml(
            UserProfileService.getInstance().getUsername(this.ownerPubkey) ||
              'the host'
          )} (optional, sent as a private message)</label>
          <textarea class="textarea textarea--small" id="booking-note-${escapeHtmlAttr(
            slot.data.dTag
          )}" data-form-note maxlength="500"></textarea>
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

  private wireForm(): void {
    if (!this.selectedDTag) return;
    const form = this.container.querySelector(
      '[data-booking-form]'
    ) as HTMLElement | null;
    if (!form) return;

    const slot = this.freeSlots.find(s => s.data.dTag === this.selectedDTag);
    if (!slot) return;

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
      void this.confirmBooking(slot, name, note);
    });
  }

  private async confirmBooking(
    slot: OwnerSlot,
    guestName: string,
    note: string
  ): Promise<void> {
    this.booking = true;
    this.render();
    const { BookingService } = await import(
      '../../addons/calendar/BookingService'
    );
    try {
      await BookingService.getInstance().bookSlot(slot.data, guestName, note);
      if (this.destroyed) return;
      this.bookedSlot = slot.data;
      this.render();
    } catch (err) {
      ToastService.show(
        `Booking failed: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      );
      this.booking = false;
      this.render();
    }
  }

  private renderSuccess(): void {
    const slot = this.bookedSlot;
    if (!slot) return;
    const when = new Date(slot.startMs).toLocaleString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
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

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.destroyed = true;
    this.container.innerHTML = '';
  }
}
