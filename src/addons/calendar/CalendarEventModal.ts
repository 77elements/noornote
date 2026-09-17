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
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { convertLineBreaks } from '../../helpers/convertLineBreaks';
import { npubToUsername } from '../../helpers/npubToUsername';
import { encodeNpub } from '../../services/NostrToolsAdapter';
import { downloadCalendarEventICS } from '../../helpers/nip52/icsExport';
import { summarizeRecurrenceRule } from '../../helpers/nip52/recurrence';
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

  constructor(
    private readonly event: CalendarEventData,
    private readonly occurrenceStartMs: number,
    private readonly onSaved?: () => void
  ) {}

  public open(): void {
    const isOwn = AuthService.getInstance().isCurrentUser(this.event.pubkey);

    const content = document.createElement('div');
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
          ? `<div class="calendar-addon-detail__desc">${convertLineBreaks(escapeHtml(this.event.description))}</div>`
          : ''
      }
      ${
        this.event.participants.length
          ? `<div class="calendar-addon-detail__row"><strong>Participants:</strong> ${escapeHtml(
              this.event.participants
                .slice(0, 12)
                .map(pk => npubToUsername(encodeNpub(pk)))
                .join(', ')
            )}${this.event.participants.length > 12 ? ` and ${this.event.participants.length - 12} more` : ''}</div>`
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
          <button class="btn btn--danger btn--medium" type="button" data-action="delete">Delete</button>`
              : ''
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
    }
  ): void {
    const total = summary.accepted + summary.declined + summary.tentative;
    const counts =
      total > 0
        ? `${summary.accepted} going · ${summary.tentative} maybe · ${summary.declined} declined`
        : 'No responses yet';

    slot.innerHTML = `
      <div class="calendar-addon-detail__rsvp-counts">${escapeHtml(counts)}</div>
      <div class="calendar-addon-detail__rsvp-buttons">
        ${RSVP_ACTIONS.map(
          action => `
        <button class="btn ${action.css} btn--mini" type="button" data-rsvp="${action.status}"
          ${summary.mine === action.status ? 'disabled' : ''}>
          ${summary.mine === action.status ? '✓ ' : ''}${action.label}
        </button>`
        ).join('')}
      </div>
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
      <div class="calendar-addon-detail__rsvp-counts">${
        total > 0
          ? `${escapeHtml(String(counts.accepted))} going · ${escapeHtml(String(counts.tentative))} maybe · ${escapeHtml(String(counts.declined))} declined`
          : 'No responses yet'
      }</div>
      <div class="calendar-addon-detail__rsvp-buttons">
        ${RSVP_ACTIONS.map(
          action => `
        <button class="btn ${action.css} btn--mini" type="button" data-rsvp="${action.status}"
          ${mine === action.status ? 'disabled' : ''}>
          ${mine === action.status ? '✓ ' : ''}${action.label}
        </button>`
        ).join('')}
      </div>
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

  /** Delete this event (public: NIP-09 via DeletionService, private: list ref + kind-5). */
  private async remove(): Promise<void> {
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
