/**
 * CalendarPublishService — write paths for NIP-52 calendar data (phase 2).
 *
 * Publishing rules (AGENTS.md): sign via AuthService.signEvent(), publish via
 * NostrTransport (publishWithOutbox → own NIP-65 write relays). Deletions via
 * the central DeletionService. RSVPs are kind 31925, parameterized
 * replaceable per (responder, event) — a deterministic d-tag makes the latest
 * status win, exactly like the Form* reference.
 */

import type { NostrEvent, NDKKind } from '@nostr-dev-kit/ndk';
import { AuthService } from '../../services/AuthService';
import { NostrTransport } from '../../services/transport/NostrTransport';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { PostsModuleApi } from '../../modules/posts/contracts';
import { diagLog } from '../../services/DiagnosticLogger';
import { encodeNaddr } from '../../services/NostrToolsAdapter';
import { resolveCalendarRelays } from './relays';
import {
  buildRecurrenceRule,
  type RecurrenceFrequency,
} from '../../helpers/nip52/recurrence';
import {
  buildCalendarCoordinate,
  calendarEventToTags,
  CALENDAR_COLLECTION_KIND,
  type CalendarCollectionData,
  type CalendarEventData,
} from '../../helpers/nip52/parser';

export type RSVPStatusValue = 'accepted' | 'declined' | 'tentative';

/** Editable shape used by the editor modal. */
export interface CalendarEventDraft {
  /** Existing d-tag (edit) or a fresh one (create). */
  dTag: string;
  /** 31923 = timed, 31922 = all-day. */
  allDay: boolean;
  title: string;
  description: string;
  startMs: number;
  /** null = no end (timed) / same-day (all-day, per NIP-52 omission). */
  endMs: number | null;
  location: string;
  image: string;
  /** null = one-off; otherwise an NIP-52R frequency. */
  repeat: RecurrenceFrequency | null;
  /** Auto-publish a kind-1 share note linking the event after saving. */
  shareInTl?: boolean | undefined;
  /** Extra hashtags → `t` tags (e.g. ['booking'] for bookable slots). */
  hashtags?: string[] | undefined;
}

export interface RSVPSummary {
  accepted: number;
  declined: number;
  tentative: number;
  /** The current user's status, or null when they have not responded. */
  mine: RSVPStatusValue | null;
}

const RANDOM_DTAG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function generateDTag(): string {
  let out = '';
  for (let i = 0; i < 16; i++) {
    out +=
      RANDOM_DTAG_ALPHABET[
        Math.floor(Math.random() * RANDOM_DTAG_ALPHABET.length)
      ];
  }
  return out;
}

export class CalendarPublishService {
  private static instance: CalendarPublishService | null = null;

  public static getInstance(): CalendarPublishService {
    if (!CalendarPublishService.instance) {
      CalendarPublishService.instance = new CalendarPublishService();
    }
    return CalendarPublishService.instance;
  }

  public static resetInstance(): void {
    CalendarPublishService.instance = null;
  }

  private readonly auth = AuthService.getInstance();
  private readonly transport = NostrTransport.getInstance();

  /** Publish (create or update) a calendar event from an editor draft. */
  public async publishEvent(draft: CalendarEventDraft): Promise<NostrEvent> {
    const user = this.auth.getCurrentUser();
    if (!user) throw new Error('Not logged in');

    const kind = draft.allDay ? 31922 : 31923;
    const startMs = draft.startMs;
    let endMs = draft.endMs;
    if (endMs !== null && endMs <= startMs) endMs = null;

    const model: CalendarEventData = {
      coordinate: `${kind}:${user.pubkey}:${draft.dTag}`,
      eventId: '',
      kind,
      pubkey: user.pubkey,
      dTag: draft.dTag,
      title: draft.title.trim(),
      description: draft.description.trim(),
      startMs,
      endMs,
      allDay: draft.allDay,
      image: draft.image.trim() || undefined,
      locations: draft.location.trim() ? [draft.location.trim()] : [],
      geoHashes: [],
      participants: [],
      hashtags: draft.hashtags ?? [],
      links: [],
      rrule: draft.repeat
        ? buildRecurrenceRule({ frequency: draft.repeat, startMs })
        : null,
      createdAt: Math.floor(Date.now() / 1000),
    };

    if (!model.title) throw new Error('Title is required');

    const unsigned = {
      kind,
      created_at: model.createdAt,
      tags: calendarEventToTags(model),
      content: model.description,
      pubkey: user.pubkey,
    };
    const signed = await this.auth.signEvent(unsigned);
    if (!signed) throw new Error('Signing failed');

    await this.transport.publishWithOutbox(signed, {
      authorPubkeys: [user.pubkey],
    });
    diagLog('system', 'calendar: event published', {
      kind,
      dTag: draft.dTag,
      edit: !!model.eventId,
    });
    return signed;
  }

  /**
   * Delete an own calendar event or collection (NIP-09).
   *
   * Two-step on purpose: (1) publish the kind-5 DIRECTLY to the calendar
   * relay set (read + aggregator + own NIP-65 outbox) — exactly where the
   * event lives; DeletionService only covers the user's active Settings
   * relays, which can miss outbox-only relays and leaves the event alive
   * there forever. (2) then DeletionService (posts module) for breadth:
   * all settings relays + the background broadcast to 1000+ relays.
   */
  public async deleteEvent(
    event: CalendarEventData,
    reason?: string
  ): Promise<boolean> {
    return this.publishDeletion(
      event.coordinate,
      event.kind,
      event.title,
      reason
    );
  }

  /**
   * Bulk deletion for the booking slot rebuild: ONE kind-5 event carrying all
   * coordinates (NIP-09 allows multiple `a` tags) to the calendar relay set,
   * plus ONE silent breadth pass. No per-item toasts — the caller (booking
   * rebuild) surfaces a single summary toast.
   */
  public async deleteEventsBulk(events: CalendarEventData[]): Promise<boolean> {
    const user = this.auth.getCurrentUser();
    if (!user || events.length === 0) return false;

    const coordinates = events.map(e => e.coordinate);
    const kinds = [...new Set(events.map(e => e.kind))];
    const unsigned = {
      kind: 5,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ...coordinates.map(coordinate => ['a', coordinate] as string[]),
        ...kinds.map(kind => ['k', String(kind)] as string[]),
      ],
      content: `Deleted ${events.length} booking slots`,
      pubkey: user.pubkey,
    };
    const signed = await this.auth.signEvent(unsigned);
    if (!signed) throw new Error('Signing failed');

    const relays = await resolveCalendarRelays([user.pubkey]);
    const accepted = await this.transport.publish(relays, signed);

    // Breadth pass (settings relays + background broadcast), silent — the
    // rebuild's summary toast is the user-facing signal.
    try {
      await ModuleLoader.getInstance()
        .getApi<PostsModuleApi>('posts')
        ?.deleteByCoordinates(
          coordinates,
          `Deleted ${events.length} booking slots`
        );
    } catch {
      // Breadth pass is best-effort.
    }

    diagLog('system', 'booking: bulk deletion', {
      slots: events.length,
      acceptedRelays: accepted.size,
    });
    return accepted.size > 0;
  }

  /** Delete an own public calendar collection (kind 31924). */
  public async deleteCollection(
    collection: CalendarCollectionData
  ): Promise<boolean> {
    const ok = await this.publishDeletion(
      collection.coordinate,
      CALENDAR_COLLECTION_KIND,
      collection.title
    );
    if (ok) {
      const { CalendarDataService } = await import('./CalendarDataService');
      CalendarDataService.getInstance().removeCollectionFromCache(
        collection.coordinate
      );
    }
    return ok;
  }

  /**
   * Publish a kind-1 "share" note that just carries the event's naddr — the
   * composer pattern used by quoted reposts: the note content is the
   * `nostr:naddr1…` reference, clients (incl. NoorNote) render it as the
   * calendar event card.
   */
  public async publishShareNote(params: {
    kind: number;
    pubkey: string;
    dTag: string;
  }): Promise<void> {
    const user = this.auth.getCurrentUser();
    if (!user) throw new Error('Not logged in');

    const naddr = encodeNaddr({
      kind: params.kind,
      pubkey: params.pubkey,
      identifier: params.dTag,
      relays: [],
    });
    const unsigned = {
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: `nostr:${naddr}`,
      pubkey: user.pubkey,
    };
    const signed = await this.auth.signEvent(unsigned);
    if (!signed) throw new Error('Signing failed');

    await this.transport.publishWithOutbox(signed, {
      authorPubkeys: [user.pubkey],
    });
    diagLog('system', 'calendar: shared in timeline', { dTag: params.dTag });
  }

  /** Shared NIP-09 deletion: targeted calendar-relay publish + breadth pass. */
  private async publishDeletion(
    coordinate: string,
    kind: number,
    title: string,
    reason?: string
  ): Promise<boolean> {
    const user = this.auth.getCurrentUser();
    if (!user) throw new Error('Not logged in');

    const unsigned = {
      kind: 5,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['a', coordinate],
        ['k', String(kind)],
      ],
      content: reason?.trim() || `Deleted calendar item "${title}"`,
      pubkey: user.pubkey,
    };
    const signed = await this.auth.signEvent(unsigned);
    if (!signed) throw new Error('Signing failed');

    const relays = await resolveCalendarRelays([user.pubkey]);
    const accepted = await this.transport.publish(relays, signed);

    // Breadth pass (settings relays + 1000+ background broadcast). The
    // own-relay publish above already guarantees the delete lands where the
    // item lives.
    try {
      const posts = ModuleLoader.getInstance().getApi<PostsModuleApi>('posts');
      void posts?.deleteByCoordinates(
        [coordinate],
        `Deleted calendar item "${title}"`
      );
    } catch {
      // Breadth pass is best-effort.
    }

    diagLog('system', 'calendar: item deleted', {
      coordinate: coordinate.slice(0, 40),
      acceptedRelays: accepted.size,
    });
    return accepted.size > 0;
  }

  /**
   * Publish (create or update) an own public calendar collection (kind 31924).
   * eventRefs are coordinates of public calendar events. Private events must
   * never be referenced — their coordinates would leak metadata publicly.
   */
  public async publishCollection(draft: {
    dTag: string;
    title: string;
    description: string;
    eventRefs: string[];
  }): Promise<CalendarCollectionData> {
    const user = this.auth.getCurrentUser();
    if (!user) throw new Error('Not logged in');
    if (!draft.title.trim()) throw new Error('Title is required');

    const unsigned = {
      kind: CALENDAR_COLLECTION_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', draft.dTag],
        ['title', draft.title.trim()],
        ...draft.eventRefs.map(ref => ['a', ref] as string[]),
      ],
      content: draft.description.trim(),
      pubkey: user.pubkey,
    };
    const signed = await this.auth.signEvent(unsigned);
    if (!signed) throw new Error('Signing failed');

    await this.transport.publishWithOutbox(signed, {
      authorPubkeys: [user.pubkey],
    });

    const coordinate = buildCalendarCoordinate(
      CALENDAR_COLLECTION_KIND,
      user.pubkey,
      draft.dTag
    );
    diagLog('system', 'calendar: collection published', {
      dTag: draft.dTag,
      events: draft.eventRefs.length,
    });

    return {
      coordinate,
      eventId: signed.id ?? '',
      pubkey: user.pubkey,
      dTag: draft.dTag,
      title: draft.title.trim(),
      description: draft.description.trim(),
      eventRefs: draft.eventRefs,
      createdAt: unsigned.created_at,
    };
  }

  /** Publish the current user's RSVP (kind 31925) for an event. */
  public async publishRSVP(
    event: CalendarEventData,
    status: RSVPStatusValue,
    comment = '',
    extraTags: string[][] = []
  ): Promise<boolean> {
    const user = this.auth.getCurrentUser();
    if (!user) throw new Error('Not logged in');

    const dTag = `${user.pubkey}:${event.pubkey}:${event.dTag}`;
    const unsigned = {
      kind: 31925,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['a', event.coordinate],
        ['d', dTag],
        ['status', status],
        ...extraTags,
      ],
      content: comment,
      pubkey: user.pubkey,
    };
    const signed = await this.auth.signEvent(unsigned);
    if (!signed) throw new Error('Signing failed');

    const accepted = await this.transport.publishWithOutbox(signed, {
      authorPubkeys: [user.pubkey],
    });
    return accepted.size > 0;
  }

  /**
   * Fetch all kind-31925 RSVPs for an event coordinate and aggregate them.
   * Latest created_at per responder wins (parameterized replaceable).
   */
  public async fetchRSVPSummary(
    event: CalendarEventData
  ): Promise<RSVPSummary> {
    const user = this.auth.getCurrentUser();
    const summary: RSVPSummary = {
      accepted: 0,
      declined: 0,
      tentative: 0,
      mine: null,
    };

    const relays = await resolveCalendarRelays([
      event.pubkey,
      ...event.participants,
    ]);
    const raw = await this.transport.fetchDirect(
      relays,
      [{ kinds: [31925 as NDKKind], '#a': [event.coordinate], limit: 200 }],
      6000,
      'calendar-rsvps'
    );

    const latestByResponder = new Map<string, NostrEvent>();
    for (const ev of raw) {
      const prev = latestByResponder.get(ev.pubkey);
      if (!prev || ev.created_at > prev.created_at) {
        latestByResponder.set(ev.pubkey, ev);
      }
    }

    for (const [pubkey, ev] of latestByResponder) {
      const status = ev.tags.find(t => t[0] === 'status')?.[1];
      if (
        status !== 'accepted' &&
        status !== 'declined' &&
        status !== 'tentative'
      ) {
        continue;
      }
      summary[status]++;
      if (user && pubkey === user.pubkey) summary.mine = status;
    }
    return summary;
  }
}
