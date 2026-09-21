/**
 * CalendarEventModal - detail view for a single NIP-52 calendar event.
 * Rendered via ModalService. Shows title, time (occurrence-aware for
 * recurring events), location, description, participants, an ICS export and
 * — phase 2 — an RSVP bar (kind 31925) plus edit/delete for own events.
 */

import { ModalService } from '../../services/ModalService';
import { ErrorService } from '../../services/ErrorService';
import { ToastService } from '../../services/ToastService';
import { AuthService } from '../../services/AuthService';
import { TypedEventBus } from '../../core/TypedEventBus';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { convertLineBreaks } from '../../helpers/convertLineBreaks';
import { npubToUsername } from '../../helpers/npubToUsername';
import { encodeNaddr, encodeNpub } from '../../services/NostrToolsAdapter';
import { downloadCalendarEventICS } from '../../helpers/nip52/icsExport';
import { summarizeRecurrenceRule } from '../../helpers/nip52/recurrence';
import { BOOKING_SLOT_DTAG_PREFIX } from '../../helpers/nip52/bookingSlots';
import { diagLog } from '../../services/DiagnosticLogger';
import { UserProfileService } from '../../services/UserProfileService';
import type { CalendarEventData } from '../../helpers/nip52/parser';
import type { RSVPStatusValue } from './CalendarPublishService';

const RSVP_ACTIONS: Array<{
  status: RSVPStatusValue;
  label: string;
  css: string;
}> = [
  { status: 'accepted', label: 'Going', css: 'btn--success' },
  { status: 'tentative', label: 'Maybe', css: 'btn--passive' },
  { status: 'declined', label: "Can't go", css: 'btn--danger' },
];

export class CalendarEventModal {
  private destroyed = false;
  /** Foreign events: currently imported into the user's grid? */
  private saved: boolean | null = null;
  private content: HTMLElement | null = null;
  /** Booking slot with at least one accepted RSVP (guest has booked). */
  private booked = false;

  constructor(
    private readonly event: CalendarEventData,
    private readonly occurrenceStartMs: number,
    private readonly onSaved?: () => void
  ) {}

  public async open(): Promise<void> {
    const isOwn = AuthService.getInstance().isCurrentUser(this.event.pubkey);

    // Foreign events: resolve whether they are already in the user's grid.
    if (!isOwn) {
      try {
        const { CalendarDataService } = await import('./CalendarDataService');
        this.saved = CalendarDataService.getInstance().isEventSaved(
          this.event.coordinate
        );
      } catch {
        this.saved = false;
      }
    }

    const content = document.createElement('div');
    this.content = content;
    content.className = 'calendar-addon-detail';
    content.innerHTML = `
      <div class="calendar-addon-detail__when">
        <span class="calendar-addon-detail__date">${escapeHtml(this.dateLabel())}</span>
        <span class="calendar-addon-detail__time">${escapeHtml(this.timeLabel())}</span>
        ${
          this.event.rrule
            ? `<span class="badge badge--accent">${escapeHtml(summarizeRecurrenceRule(this.event.rrule))}</span>`
            : ''
        }
      </div>
      ${
        this.event.image
          ? `<img class="calendar-addon-detail__image" src="${escapeHtmlAttr(this.event.image)}" alt="" loading="lazy" />`
          : ''
      }
      ${
        this.event.locations.length
          ? `<div class="calendar-addon-detail__row"><strong>Where:</strong> ${escapeHtml(this.event.locations.join(', '))}</div>`
          : ''
      }
      ${
        this.event.description
          ? `<p class="calendar-addon-detail__desc">${convertLineBreaks(escapeHtml(this.event.description))}</p>`
          : ''
      }
      ${
        this.event.participants.length
          ? `<p class="calendar-addon-detail__row"><strong>Participants:</strong> ${escapeHtml(
              this.event.participants
                .slice(0, 12)
                .map(pk => npubToUsername(encodeNpub(pk)))
                .join(', ')
            )}${this.event.participants.length > 12 ? ` and ${this.event.participants.length - 12} more` : ''}</p>`
          : ''
      }
      ${
        this.event.hashtags.length
          ? `<div class="calendar-addon-detail__hashtags">${this.event.hashtags.map(tag => `<span class="badge">#${escapeHtml(tag)}</span>`).join(' ')}</div>`
          : ''
      }
      ${
        this.event.isPrivate
          ? '<div class="calendar-addon-detail__row"><span class="badge badge--accent">Private — encrypted</span></div><div class="calendar-addon-detail__rsvp" data-slot="private-rsvp"><div class="calendar-addon-detail__rsvp-loading pulsate">Loading responses…</div></div>'
          : '<div class="calendar-addon-detail__rsvp" data-slot="rsvp"></div>'
      }
      <div class="calendar-addon-detail__actions l-row--split">
        <div class="l-row">
          ${
            isOwn
              ? `<button class="btn btn--passive btn--medium" type="button" data-action="edit">Edit</button>
          <button class="btn btn--danger btn--medium" type="button" data-action="delete">Delete</button>
          <button class="btn btn--passive btn--medium" type="button" data-action="share">Share in TL</button>`
              : this.event.isPrivate
                ? ''
                : `<button class="btn ${this.saved ? 'btn--danger' : 'btn--passive'} btn--medium" type="button" data-action="save-toggle">
              ${this.saved ? 'Remove' : '+ Add to my cal'}
            </button>
          <button class="btn btn--passive btn--medium" type="button" data-action="share">Share in TL</button>`
          }
        </div>
        <div class="l-row">
          <button class="btn btn--passive btn--medium" type="button" data-action="ics">Download .ics</button>
        </div>
      </div>
    `;

    content
      .querySelector('[data-action="ics"]')
      ?.addEventListener('click', () => {
        try {
          downloadCalendarEventICS(this.event);
          ToastService.show('Calendar file downloaded', 'success');
        } catch (error) {
          ErrorService.handle(
            error,
            'CalendarEventModal.exportICS',
            true,
            'Could not export event'
          );
        }
      });

    content
      .querySelector('[data-action="edit"]')
      ?.addEventListener('click', () => {
        void this.openEditor();
      });
    content
      .querySelector('[data-action="delete"]')
      ?.addEventListener('click', () => {
        void this.remove();
      });
    content
      .querySelector('[data-action="save-toggle"]')
      ?.addEventListener('click', () => {
        void this.toggleSave(content);
      });
    content
      .querySelector('[data-action="share"]')
      ?.addEventListener('click', () => {
        void this.shareInTl();
      });

    ModalService.getInstance().show({
      title: this.event.title || '(Untitled event)',
      content,
      width: '560px',
    });

    if (!this.event.isPrivate) {
      void this.loadRsvps(content);
    } else {
      void this.loadPrivateRsvps(content);
    }
  }

  private async loadRsvps(content: HTMLElement): Promise<void> {
    const slot = content.querySelector<HTMLElement>('[data-slot="rsvp"]');
    if (!slot) return;
    try {
      const { CalendarPublishService } = await import(
        './CalendarPublishService'
      );
      const summary =
        await CalendarPublishService.getInstance().fetchRSVPSummary(this.event);
      if (this.destroyed || !slot.isConnected) return;
      this.renderRsvpBar(slot, summary);
    } catch (error) {
      if (this.destroyed || !slot.isConnected) return;
      ErrorService.handle(error, 'CalendarEventModal.fetchRSVPs');
      slot.innerHTML =
        '<div class="calendar-addon-detail__rsvp-empty">Responses could not be loaded.</div>';
    }
  }

  private renderRsvpBar(
    slot: HTMLElement,
    summary: {
      accepted: number;
      declined: number;
      tentative: number;
      mine: RSVPStatusValue | null;
      acceptedBy: string[];
    }
  ): void {
    // Booking slot with an accepted RSVP: clearly flagged as a booked
    // appointment — the Edit affordance goes away (delete only), and the
    // banner shows who booked it.
    const isBookedSlot =
      this.event.dTag.startsWith(BOOKING_SLOT_DTAG_PREFIX) &&
      summary.accepted > 0;
    this.booked = isBookedSlot;
    if (isBookedSlot) {
      this.content?.querySelector('[data-action="edit"]')?.remove();
      // Green "booked" suffix on the modal title (h1 lives in .modal__header).
      const titleEl = document.querySelector('.modal__header h1');
      if (titleEl && !titleEl.querySelector('.nn-booked-suffix')) {
        titleEl.insertAdjacentHTML(
          'beforeend',
          ' <span class="nn-booked-suffix">- booked</span>'
        );
      }
      if (slot.querySelector('.calendar-addon-detail__booked-banner')) return;
      const guestName =
        UserProfileService.getInstance().getUsername(summary.acceptedBy[0]!) ||
        'a guest';
      slot.insertAdjacentHTML(
        'afterbegin',
        `<div class="calendar-addon-detail__booked-banner">✓ Booked appointment — guest: ${escapeHtml(guestName)}</div>`
      );
    }

    const total = summary.accepted + summary.declined + summary.tentative;
    const counts =
      total > 0
        ? `${summary.accepted} going · ${summary.tentative} maybe · ${summary.declined} declined`
        : 'No responses yet';

    slot.innerHTML = `
      <div class="calendar-addon-detail__rsvp-buttons">
        ${RSVP_ACTIONS.map(
          action => `
        <button class="btn btn--passive btn--mini" type="button" data-rsvp="${action.status}"
          ${summary.mine === action.status ? 'disabled' : ''}>
          ${summary.mine === action.status ? '✓ ' : ''}${action.label}
        </button>`
        ).join('')}
      </div>
      <div class="calendar-addon-detail__rsvp-counts">${escapeHtml(counts)}</div>
    `;

    slot.querySelectorAll('[data-rsvp]').forEach(button => {
      button.addEventListener('click', () => {
        void this.sendRsvp(
          slot,
          (button as HTMLElement).dataset.rsvp as RSVPStatusValue
        );
      });
    });
  }

  private async sendRsvp(
    slot: HTMLElement,
    status: RSVPStatusValue
  ): Promise<void> {
    try {
      const { CalendarPublishService } = await import(
        './CalendarPublishService'
      );
      await CalendarPublishService.getInstance().publishRSVP(
        this.event,
        status
      );
      // Booking slot declined via the generic RSVP bar → clean up the
      // decliner's own booking artifacts (grid import + guest reminder).
      if (
        this.event.dTag.startsWith(BOOKING_SLOT_DTAG_PREFIX) &&
        status === 'declined'
      ) {
        await this.cleanupBookingParticipation();
      }
      ToastService.show('Response published', 'success');
      const summary =
        await CalendarPublishService.getInstance().fetchRSVPSummary(this.event);
      if (!this.destroyed && slot.isConnected)
        this.renderRsvpBar(slot, summary);
    } catch (error) {
      ErrorService.handle(
        error,
        'CalendarEventModal.sendRSVP',
        true,
        'Could not publish your response'
      );
    }
  }

  /**
   * Decliner-side cleanup for booking slots: the declined RSVP is already
   * published — this informs owner + participants (DM) and cleans up the
   * decliner's device state (calendar import, guest reminder record).
   */
  private async cleanupBookingParticipation(): Promise<void> {
    try {
      const { BookingService } = await import('./BookingService');
      await BookingService.getInstance().notifyAndCleanupCancellation(
        this.event,
        ''
      );
    } catch (err) {
      diagLog('system', 'booking: participation cleanup failed', {
        error: String(err),
      });
    }
    try {
      const { ReminderHub } = await import(
        '../../services/notifications/ReminderHub'
      );
      ReminderHub.getInstance().rescheduleSoon('booking-guest');
    } catch (err) {
      diagLog('system', 'booking: cleanup failed', { error: String(err) });
    }
  }

  /** Phase 3b: private RSVPs (kind 32069, view-key encrypted aggregate). */
  private async loadPrivateRsvps(content: HTMLElement): Promise<void> {
    const slot = content.querySelector<HTMLElement>(
      '[data-slot="private-rsvp"]'
    );
    if (!slot) return;
    try {
      const { CalendarInviteService } = await import('./CalendarInviteService');
      const records =
        await CalendarInviteService.getInstance().fetchPrivateRSVPs(this.event);
      if (this.destroyed || !slot.isConnected) return;
      this.renderPrivateRsvpBar(slot, records);
    } catch (error) {
      if (this.destroyed || !slot.isConnected) return;
      ErrorService.handle(error, 'CalendarEventModal.fetchPrivateRSVPs');
      slot.innerHTML =
        '<div class="calendar-addon-detail__rsvp-empty">Responses could not be loaded.</div>';
    }
  }

  private renderPrivateRsvpBar(
    slot: HTMLElement,
    records: Array<{
      responderPubkey: string;
      status: 'accepted' | 'declined' | 'tentative';
    }>
  ): void {
    const user = AuthService.getInstance().getCurrentUser();
    const mine = user
      ? (records.find(record => record.responderPubkey === user.pubkey)
          ?.status ?? null)
      : null;
    const counts = {
      accepted: records.filter(record => record.status === 'accepted').length,
      tentative: records.filter(record => record.status === 'tentative').length,
      declined: records.filter(record => record.status === 'declined').length,
    };
    const total = records.length;

    slot.innerHTML = `
      <div class="calendar-addon-detail__rsvp-buttons">
        ${RSVP_ACTIONS.map(
          action => `
        <button class="btn btn--passive btn--mini" type="button" data-rsvp="${action.status}"
          ${mine === action.status ? 'disabled' : ''}>
          ${mine === action.status ? '✓ ' : ''}${action.label}
        </button>`
        ).join('')}
      </div>
      <div class="calendar-addon-detail__rsvp-counts">${
        total > 0
          ? `${escapeHtml(String(counts.accepted))} going · ${escapeHtml(String(counts.tentative))} maybe · ${escapeHtml(String(counts.declined))} declined`
          : 'No responses yet'
      }</div>
    `;

    slot.querySelectorAll('[data-rsvp]').forEach(button => {
      button.addEventListener('click', () => {
        void this.sendPrivateRsvp(
          slot,
          (button as HTMLElement).dataset.rsvp as RSVPStatusValue
        );
      });
    });
  }

  private async sendPrivateRsvp(
    slot: HTMLElement,
    status: RSVPStatusValue
  ): Promise<void> {
    try {
      const { CalendarInviteService } = await import('./CalendarInviteService');
      await CalendarInviteService.getInstance().publishPrivateRSVP(
        this.event,
        status
      );
      ToastService.show('Response published', 'success');
      const records =
        await CalendarInviteService.getInstance().fetchPrivateRSVPs(this.event);
      if (!this.destroyed && slot.isConnected) {
        this.renderPrivateRsvpBar(slot, records);
      }
    } catch (error) {
      ErrorService.handle(
        error,
        'CalendarEventModal.sendPrivateRSVP',
        true,
        'Could not publish your response'
      );
    }
  }

  private async openEditor(): Promise<void> {
    const { CalendarEventEditor } = await import('./CalendarEventEditor');
    ModalService.getInstance().hide();
    new CalendarEventEditor(() => this.onSaved?.(), this.event).open();
  }

  /**
   * Share this event in the timeline: opens the note composer pre-filled
   * with the event's naddr reference (same pattern as quoted reposts).
   * Public events only — private events have no public address to share.
   */
  private async shareInTl(): Promise<void> {
    if (this.event.isPrivate) return;
    const { PostNoteModal } = await import(
      '../../components/post/PostNoteModal'
    );
    ModalService.getInstance().hide();
    PostNoteModal.getInstance().show(
      `nostr:${encodeNaddr({
        kind: this.event.kind,
        pubkey: this.event.pubkey,
        identifier: this.event.dTag,
        relays: [],
      })}`
    );
  }

  /**
   * Foreign events: add/remove the local grid reference. "Remove" confirms
   * first (user decision) — it only drops the local reference, the event
   * itself stays untouched.
   */
  private async toggleSave(content: HTMLElement): Promise<void> {
    const { CalendarDataService } = await import('./CalendarDataService');
    const data = CalendarDataService.getInstance();
    const coordinate = this.event.coordinate;

    if (this.saved) {
      const confirmed = await ModalService.getInstance().confirm({
        title: 'Remove from your calendar',
        message: `Remove "${this.event.title || 'this event'}" from your calendar grid? The event itself stays untouched.`,
        confirmText: 'Remove',
        confirmDestructive: true,
      });
      if (!confirmed) return;
      data.unsaveEvent(coordinate);
      this.saved = false;
      ToastService.show('Removed from your calendar', 'success');
    } else {
      data.saveEvent(coordinate);
      this.saved = true;
      ToastService.show('Added to your calendar grid', 'success');
    }

    const btn = content.querySelector<HTMLButtonElement>(
      '[data-action="save-toggle"]'
    );
    if (btn) {
      btn.textContent = this.saved ? 'Remove' : '+ Add to my cal';
      btn.classList.toggle('btn--danger', this.saved);
      btn.classList.toggle('btn--passive', !this.saved);
    }
    // Let the (possibly open) grid reload immediately.
    TypedEventBus.getInstance().emit('calendar:saved-changed', {});
  }

  /** Delete this event (public: NIP-09 via DeletionService, private: list ref + kind-5). */
  private async remove(): Promise<void> {
    // Booked appointment: cancellation = slot deletion + guest/participant
    // DMs (ownerCancelBooking), with an optional reason.
    if (this.booked) {
      const { ModalService: ModalSvc } = await import(
        '../../services/ModalService'
      );
      const reason = await ModalSvc.getInstance().prompt({
        title: 'Cancel booking',
        message:
          'The guest and all participants will be informed about the cancellation by DM.',
        placeholder: 'Reason (optional)',
        multiline: true,
        allowEmpty: true,
        confirmText: 'Cancel booking',
      });
      if (reason === null) return;
      const { BookingService } = await import('./BookingService');
      const result = await BookingService.getInstance().cancelBookingAsOwner(
        this.event,
        reason
      );
      if (this.destroyed) return;
      ToastService.show(
        result.ok
          ? result.dmFailures
            ? `${result.detail} — ${result.dmFailures} DM(s) failed`
            : 'Booking cancelled — guest and participants informed'
          : result.detail,
        result.ok && !result.dmFailures ? 'success' : 'warning'
      );
      if (result.ok) {
        ModalSvc.getInstance().hide();
        this.onSaved?.();
      }
      return;
    }

    const confirmed = await ModalService.getInstance().confirm({
      title: 'Delete event',
      message: `Delete "${this.event.title || 'this event'}"${this.event.isPrivate ? '' : ' for everyone'}? A deletion request is published to relays.`,
      confirmText: 'Delete',
      confirmDestructive: true,
    });
    if (!confirmed) return;

    try {
      if (this.event.isPrivate) {
        const { PrivateCalendarService } = await import(
          './PrivateCalendarService'
        );
        await PrivateCalendarService.getInstance().deletePrivateEvent(
          this.event
        );
      } else {
        const { CalendarPublishService } = await import(
          './CalendarPublishService'
        );
        await CalendarPublishService.getInstance().deleteEvent(this.event);
      }
      ToastService.show('Event deleted', 'success');
      ModalService.getInstance().hide();
      this.onSaved?.();
    } catch (error) {
      ErrorService.handle(
        error,
        'CalendarEventModal.remove',
        true,
        'Could not delete the event'
      );
    }
  }

  private dateLabel(): string {
    return new Date(this.occurrenceStartMs).toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  private timeLabel(): string {
    if (this.event.allDay) return 'All day';
    const duration =
      (this.event.endMs ?? this.event.startMs) - this.event.startMs;
    const start = new Date(this.occurrenceStartMs).toLocaleTimeString(
      undefined,
      {
        hour: '2-digit',
        minute: '2-digit',
      }
    );
    if (duration <= 0) return start;
    const end = new Date(this.occurrenceStartMs + duration).toLocaleTimeString(
      undefined,
      { hour: '2-digit', minute: '2-digit' }
    );
    return `${start} – ${end}`;
  }
}
