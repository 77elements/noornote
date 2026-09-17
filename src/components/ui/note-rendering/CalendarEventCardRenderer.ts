/**
 * CalendarEventCardRenderer - Renders NIP-52 calendar events
 * (kinds 31922/31923) and collections (kind 31924) as nn-cards in TV/PV/SNV.
 * Clicking opens the addon's detail modal (dynamic import keeps the calendar
 * chunk lazy).
 */

import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { NoteHeader } from '../NoteHeader';
import { AuthService } from '../../../services/AuthService';
import { ToastService } from '../../../services/ToastService';
import {
  parseCalendarEvent,
  parseCalendarCollection,
  type CalendarEventRawInput,
} from '../../../helpers/nip52/parser';
import { getAddressableIdentifier } from '../../../helpers/getAddressableIdentifier';
import { escapeHtml, escapeHtmlAttr } from '../../../helpers/escapeHtml';
import { appendPackISL } from './packCardShared';

function formatWhen(
  startMs: number,
  endMs: number | null,
  allDay: boolean
): string {
  const date = new Date(startMs).toLocaleDateString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  if (allDay) return `${date} · All day`;
  const time = new Date(startMs).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (endMs !== null && endMs > startMs) {
    const endTime = new Date(endMs).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
    return `${date} · ${time} – ${endTime}`;
  }
  return `${date} · ${time}`;
}

export class CalendarEventCardRenderer {
  /** Shared card scaffold: NoteHeader + nn-card body + ISL (both variants). */
  private static buildCard(
    note: ProcessedNote,
    opts: NoteUIOptions,
    cssModifier: string,
    bodyHtml: string,
    onCardClick: () => void
  ): HTMLElement {
    const event = note.rawEvent;
    const element = document.createElement('div');
    element.className = `note-card note-card--${cssModifier}`;
    element.dataset.eventId = note.id;

    const noteHeader = new NoteHeader({
      pubkey: event.pubkey,
      eventId: note.id,
      timestamp: note.timestamp,
      rawEvent: event,
      showVerification: true,
      showTimestamp: true,
      showMenu: true,
    });
    element.appendChild(noteHeader.getElement());

    const card = document.createElement('div');
    card.className = 'nn-card';
    card.innerHTML = bodyHtml;
    card.addEventListener('click', e => {
      const target = e.target as HTMLElement;
      if (target.closest('.note-image--clickable, .note-media, video')) return;
      if (target.closest('button') || target.closest('a')) return;
      onCardClick();
    });
    element.appendChild(card);

    const addressableId = getAddressableIdentifier(event);
    const noteId = addressableId || event.id;
    if (noteId) appendPackISL(element, event, noteId, opts);

    return element;
  }

  static render(note: ProcessedNote, opts: NoteUIOptions): HTMLElement {
    const event = note.rawEvent;
    const parsed = parseCalendarEvent(event);
    const coverClass = parsed?.image
      ? 'nn-card__media'
      : 'nn-card__media nn-card__media--empty';
    const body = `
      <div class="${coverClass}">
        ${parsed?.image ? `<img src="${escapeHtmlAttr(parsed.image)}" alt="" loading="lazy" />` : ''}
      </div>
      <div class="nn-card__content">
        <h3>${escapeHtml(parsed?.title || '(Untitled event)')}</h3>
        <div class="meta">${escapeHtml(
          parsed
            ? formatWhen(parsed.startMs, parsed.endMs, parsed.allDay)
            : 'Calendar event'
        )}</div>
        ${parsed?.locations.length ? `<div class="meta">${escapeHtml(parsed.locations.join(', '))}</div>` : ''}
      </div>
    `;
    return CalendarEventCardRenderer.buildCard(
      note,
      opts,
      'calendar-event',
      body,
      () => void CalendarEventCardRenderer.openDetailModal(event)
    );
  }

  /** Collection (kind 31924) as a compact nn-card with a subscribe toggle. */
  static renderCollection(
    note: ProcessedNote,
    opts: NoteUIOptions
  ): HTMLElement {
    const event = note.rawEvent;
    const parsed = parseCalendarCollection(event);
    const coordinate = parsed?.coordinate ?? '';
    const isOwn = AuthService.getInstance().isCurrentUser(event.pubkey);
    const body = `
      <div class="nn-card__content">
        <h3>${escapeHtml(parsed?.title || 'Calendar')}</h3>
        <div class="meta">Calendar · ${parsed?.eventRefs.length ?? 0} events</div>
        ${
          isOwn || !coordinate
            ? ''
            : `<button class="btn btn--passive btn--mini" type="button" data-action="subscribe">+ Subscribe</button>`
        }
      </div>
    `;
    const card = CalendarEventCardRenderer.buildCard(
      note,
      opts,
      'calendar-collection',
      body,
      () => {}
    );

    // Wire the subscribe toggle (async import keeps the addon chunk lazy;
    // the label reflects the current subscription state).
    const subscribeBtn = card.querySelector('[data-action="subscribe"]');
    if (subscribeBtn && coordinate) {
      void import('../../../addons/calendar/CalendarDataService').then(
        ({ CalendarDataService }) => {
          const data = CalendarDataService.getInstance();
          const refresh = () => {
            const active = data.isCollectionSubscribed(coordinate);
            subscribeBtn.textContent = active ? '✓ Subscribed' : '+ Subscribe';
            subscribeBtn.classList.toggle('btn--passive', !active);
            subscribeBtn.classList.toggle('btn--success', active);
          };
          refresh();
          subscribeBtn.addEventListener('click', e => {
            e.stopPropagation();
            if (data.isCollectionSubscribed(coordinate)) {
              data.unsubscribeFromCollection(coordinate);
              ToastService.show('Unsubscribed from calendar', 'success');
            } else {
              data.subscribeToCollection(coordinate);
              ToastService.show(
                'Subscribed — events added to your calendar grid',
                'success'
              );
            }
            refresh();
          });
        }
      );
    }

    return card;
  }

  /** Open the addon detail modal (dynamic import — keeps the chunk lazy). */
  public static async openDetailModal(
    event: CalendarEventRawInput
  ): Promise<void> {
    const parsed = parseCalendarEvent(event);
    if (!parsed) return;
    const { CalendarEventModal } = await import(
      '../../../addons/calendar/CalendarEventModal'
    );
    new CalendarEventModal(parsed, parsed.startMs).open();
  }
}
