/**
 * CalendarCollectionDetailModal - detail view for a public event calendar
 * (kind 31924): lists the calendar's events and offers subscription
 * (foreign calendars) or editing (own calendars).
 *
 * Member events are resolved live from the relays (grouped by author, latest
 * addressable version wins). Rows are read-only here — opening a single
 * event's full modal from inside this modal would cascade ModalService.
 */

import { ModalService } from '../../services/ModalService';
import { ErrorService } from '../../services/ErrorService';
import { ToastService } from '../../services/ToastService';
import { AuthService } from '../../services/AuthService';
import { escapeHtml } from '../../helpers/escapeHtml';
import { CalendarDataService } from './CalendarDataService';
import {
  parseCalendarEvent,
  type CalendarCollectionData,
  type CalendarEventData,
} from '../../helpers/nip52/parser';

export class CalendarCollectionDetailModal {
  private destroyed = false;

  constructor(
    private readonly collection: CalendarCollectionData,
    private readonly onChanged?: () => void
  ) {}

  public async open(): Promise<void> {
    const isOwn = AuthService.getInstance().isCurrentUser(
      this.collection.pubkey
    );

    const content = document.createElement('div');
    content.className = 'calendar-collection-detail';
    content.innerHTML = `
      ${this.collection.description ? `<p class="calendar-addon-detail__desc">${escapeHtml(this.collection.description)}</p>` : ''}
      <div class="calendar-addon-detail__rsvp" data-slot="events">
        <div class="calendar-addon-detail__rsvp-loading pulsate">Loading events…</div>
      </div>
      <div class="calendar-addon-detail__actions l-row--split">
        <div class="l-row">
          ${
            isOwn
              ? '<button class="btn btn--passive btn--medium" type="button" data-action="edit">Edit calendar</button>'
              : `<button class="btn ${
                  CalendarDataService.getInstance().isCollectionSubscribed(
                    this.collection.coordinate
                  )
                    ? 'btn--danger'
                    : 'btn--passive'
                } btn--medium" type="button" data-action="subscribe">
              ${
                CalendarDataService.getInstance().isCollectionSubscribed(
                  this.collection.coordinate
                )
                  ? 'Unsubscribe'
                  : '+ Subscribe'
              }
            </button>`
          }
        </div>
        <div class="l-row"></div>
      </div>
    `;

    ModalService.getInstance().show({
      title: this.collection.title || 'Event calendar',
      content,
      width: '560px',
    });

    void this.loadEvents(content.querySelector('[data-slot="events"]')!);
    content
      .querySelector('[data-action="subscribe"]')
      ?.addEventListener('click', () => {
        void this.toggleSubscribe(content);
      });
    content
      .querySelector('[data-action="edit"]')
      ?.addEventListener('click', () => {
        void this.openEditor();
      });
  }

  private async loadEvents(slot: HTMLElement): Promise<void> {
    try {
      const { CalendarDataService } = await import('./CalendarDataService');
      const groups = new Map<
        string,
        { kinds: number[]; author: string; dTags: string[] }
      >();
      for (const ref of this.collection.eventRefs) {
        const [kindStr, author, ...rest] = ref.split(':');
        const dTag = rest.join(':');
        const kind = Number(kindStr);
        if (!author || !dTag || ![31922, 31923].includes(kind)) continue;
        const group = groups.get(author) ?? { kinds: [], author, dTags: [] };
        if (!group.kinds.includes(kind)) group.kinds.push(kind);
        group.dTags.push(dTag);
        groups.set(author, group);
      }

      const events: CalendarEventData[] = [];
      for (const group of groups.values()) {
        const raw = await CalendarDataService.getInstance().fetchForeignEvents(
          group.author,
          group.kinds,
          group.dTags
        );
        const seen = new Set<string>();
        for (const ev of raw) {
          const parsed = parseCalendarEvent(ev);
          if (parsed && !seen.has(parsed.coordinate)) {
            seen.add(parsed.coordinate);
            events.push(parsed);
          }
        }
      }
      events.sort((a, b) => a.startMs - b.startMs);

      if (this.destroyed || !slot.isConnected) return;
      this.renderEventList(slot, events);
    } catch (error) {
      if (this.destroyed || !slot.isConnected) return;
      ErrorService.handle(error, 'CalendarCollectionDetailModal.loadEvents');
      slot.innerHTML =
        '<div class="calendar-collections__empty">Events could not be loaded.</div>';
    }
  }

  private renderEventList(
    slot: HTMLElement,
    events: CalendarEventData[]
  ): void {
    if (events.length === 0) {
      slot.innerHTML =
        '<div class="calendar-collections__empty">This calendar has no events yet.</div>';
      return;
    }
    slot.innerHTML = `
      <div class="ui-list">
        ${events
          .map(
            event => `
        <div class="ui-list__item calendar-collections__row">
          <span class="calendar-collections__title">${escapeHtml(
            event.title || '(Untitled event)'
          )}</span>
          <span class="calendar-collections__meta">${escapeHtml(
            this.dateLabel(event)
          )}</span>
        </div>`
          )
          .join('')}
      </div>
    `;
  }

  private dateLabel(event: CalendarEventData): string {
    const date = new Date(event.startMs).toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
    if (event.allDay) return date;
    const time = new Date(event.startMs).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
    return `${date}, ${time}`;
  }

  private async toggleSubscribe(content: HTMLElement): Promise<void> {
    const data = CalendarDataService.getInstance();
    const coordinate = this.collection.coordinate;
    const subscribed = data.isCollectionSubscribed(coordinate);
    if (subscribed) {
      data.unsubscribeFromCollection(coordinate);
      ToastService.show('Unsubscribed from calendar', 'success');
    } else {
      data.subscribeToCollection(coordinate);
      ToastService.show(
        'Subscribed — events added to your calendar grid',
        'success'
      );
    }
    this.onChanged?.();

    // Refresh the toggle in place.
    const btn = content.querySelector<HTMLButtonElement>(
      '[data-action="subscribe"]'
    );
    if (btn) {
      const nowSubscribed = data.isCollectionSubscribed(coordinate);
      btn.textContent = nowSubscribed ? 'Unsubscribe' : '+ Subscribe';
      btn.classList.toggle('btn--danger', nowSubscribed);
      btn.classList.toggle('btn--passive', !nowSubscribed);
    }
  }

  private async openEditor(): Promise<void> {
    ModalService.getInstance().hide();
    const { CalendarCollectionEditorModal } = await import(
      './CalendarCollectionsModal'
    );
    new CalendarCollectionEditorModal(this.collection, () =>
      this.onChanged?.()
    ).open();
  }
}
