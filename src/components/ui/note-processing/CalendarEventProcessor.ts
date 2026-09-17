/**
 * CalendarEventProcessor - NIP-52 calendar events (kinds 31922/31923)
 * and calendar collections (kind 31924) for timeline display.
 * Rendering is handled by CalendarEventCardRenderer (nn-card style).
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';
import {
  CALENDAR_COLLECTION_KIND,
  CALENDAR_EVENT_DATE_KIND,
  CALENDAR_EVENT_TIME_KIND,
} from '../../../helpers/nip52/parser';

export class CalendarEventProcessor {
  static process(event: NostrEvent): ProcessedNote {
    const eventId = event.id;
    if (!eventId) {
      throw new Error('Event ID is required');
    }

    return {
      id: eventId,
      type:
        event.kind === CALENDAR_COLLECTION_KIND
          ? 'calendar-collection'
          : 'calendar-event',
      timestamp: event.created_at,
      author: { pubkey: event.pubkey },
      content: {
        text: '',
        html: '',
        media: [],
        links: [],
        hashtags: [],
        quotedReferences: [],
        bolt11Invoices: [],
      },
      rawEvent: event,
    };
  }
}

/** Kinds routed through the calendar pipeline (processor + card renderer). */
export const CALENDAR_FEED_KINDS = [
  CALENDAR_EVENT_DATE_KIND,
  CALENDAR_EVENT_TIME_KIND,
  CALENDAR_COLLECTION_KIND,
] as const;

export function isCalendarFeedKind(kind: number | undefined): boolean {
  return (
    kind === CALENDAR_EVENT_DATE_KIND ||
    kind === CALENDAR_EVENT_TIME_KIND ||
    kind === CALENDAR_COLLECTION_KIND
  );
}
