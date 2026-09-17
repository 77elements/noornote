/**
 * CalendarDataService — fetches + caches the user's NIP-52 calendar data.
 *
 * Phase 1 scope: the user's OWN events (kinds 31922/31923) and OWN calendar
 * collections (kind 31924). Foreign events are rendered where they appear in
 * the feed (kind renderer) — no global firehose (privacy: fetching everything
 * would announce interest in strangers' schedules).
 *
 * Data flows through NostrTransport (pooled NDK, Transport-Guard) with the
 * analytics relay strategy: read + aggregator relays plus the user's NIP-65
 * outbox, since addressable events often live ONLY on their write relays.
 * Results are cached per-account (PerAccountLocalStorage) for instant render.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { NostrTransport } from '../../services/transport/NostrTransport';
import {
  PerAccountLocalStorage,
  StorageKeys,
} from '../../services/PerAccountLocalStorage';
import { AuthService } from '../../services/AuthService';
import { diagLog } from '../../services/DiagnosticLogger';
import { dedupeByCoordinateWithTombstones } from '../../helpers/addressableDedupe';
import { resolveCalendarRelays } from './relays';
import {
  CALENDAR_EVENT_DATE_KIND,
  CALENDAR_EVENT_TIME_KIND,
  CALENDAR_COLLECTION_KIND,
  parseCalendarCollection,
  parseCalendarEvent,
  type CalendarCollectionData,
  type CalendarEventData,
} from '../../helpers/nip52/parser';

const FETCH_TIMEOUT_MS = 8000;

const CALENDAR_KINDS = [
  CALENDAR_EVENT_DATE_KIND,
  CALENDAR_EVENT_TIME_KIND,
  CALENDAR_COLLECTION_KIND,
];

/** NIP-09 `a`-tag deletion prefixes targeting our addressable kinds. */
const COORD_PREFIXES = CALENDAR_KINDS.map(k => `${k}:`);

interface CalendarCache {
  version: 2;
  events: CalendarEventData[];
  collections: CalendarCollectionData[];
}

export class CalendarDataService {
  private static instance: CalendarDataService | null = null;

  public static getInstance(): CalendarDataService {
    if (!CalendarDataService.instance) {
      CalendarDataService.instance = new CalendarDataService();
    }
    return CalendarDataService.instance;
  }

  /** Reset the singleton (account switch — the runtime destroy contract). */
  public static resetInstance(): void {
    CalendarDataService.instance = null;
  }

  private readonly transport = NostrTransport.getInstance();
  private fetchInFlight: Promise<{
    events: CalendarEventData[];
    collections: CalendarCollectionData[];
  }> | null = null;
  private destroyed = false;

  /** Cached events for instant render (may be empty on first login). */
  public getCachedEvents(): CalendarEventData[] {
    const cache = this.readCache();
    return cache?.events ?? [];
  }

  public getCachedCollections(): CalendarCollectionData[] {
    const cache = this.readCache();
    return cache?.collections ?? [];
  }

  /**
   * Fetch own calendar events + collections from relays, tombstone-filter,
   * dedupe by coordinate and update the per-account cache. Concurrent calls
   * share one in-flight fetch.
   */
  public async fetchOwnCalendarData(): Promise<{
    events: CalendarEventData[];
    collections: CalendarCollectionData[];
  }> {
    if (this.fetchInFlight) return this.fetchInFlight;

    this.fetchInFlight = (async () => {
      const pubkey = AuthService.getInstance().getCurrentUser()?.pubkey ?? '';
      if (!pubkey || this.destroyed) {
        return {
          events: this.getCachedEvents(),
          collections: this.getCachedCollections(),
        };
      }

      const relays = await resolveCalendarRelays([pubkey]);
      if (this.destroyed || relays.length === 0) {
        return {
          events: this.getCachedEvents(),
          collections: this.getCachedCollections(),
        };
      }

      const rawEvents = await this.transport.fetchDirect(
        relays,
        [
          {
            kinds: CALENDAR_KINDS,
            authors: [pubkey],
            limit: 500,
          },
        ],
        FETCH_TIMEOUT_MS,
        'calendar-own'
      );

      // Separately fetch kind 5 deletions (fetchDirect requires kind filters
      // to stay focused; deletions arrive as their own query).
      const deletionEvents = await this.transport.fetchDirect(
        relays,
        [
          {
            kinds: [5],
            authors: [pubkey],
            limit: 100,
          },
        ],
        FETCH_TIMEOUT_MS,
        'calendar-deletions'
      );

      const surviving = dedupeByCoordinateWithTombstones(
        rawEvents,
        deletionEvents,
        COORD_PREFIXES
      );

      const events: CalendarEventData[] = [];
      const collections: CalendarCollectionData[] = [];
      for (const ev of surviving) {
        if (ev.kind === CALENDAR_COLLECTION_KIND) {
          const parsed = parseCalendarCollection(ev);
          if (parsed) collections.push(parsed);
        } else {
          const parsed = parseCalendarEvent(ev);
          if (parsed) events.push(parsed);
        }
      }

      // Phase 3a: merge own private (NIP-52E) events into the same grid.
      let privateEvents: CalendarEventData[] = [];
      try {
        const { PrivateCalendarService } = await import(
          './PrivateCalendarService'
        );
        privateEvents =
          await PrivateCalendarService.getInstance().fetchOwnPrivateEvents();
      } catch {
        // Private calendar is best-effort — public data still renders.
      }

      events.sort((a, b) => a.startMs - b.startMs);

      this.writeCache({
        version: 2,
        events: [...events, ...privateEvents],
        collections,
      });
      diagLog('system', 'calendar: own data fetched', {
        events: events.length,
        privateEvents: privateEvents.length,
        collections: collections.length,
        relays: relays.length,
      });
      return { events: [...events, ...privateEvents], collections };
    })();

    try {
      return await this.fetchInFlight;
    } finally {
      this.fetchInFlight = null;
    }
  }

  /**
   * Fetch non-own events referenced by collections (grouped by author+kind,
   * one relay query per group). Resolve the author's outbox so events are
   * found even when they only live on the author's write relays.
   */
  public async fetchForeignEvents(
    authorPubkey: string,
    kinds: number[],
    dTags: string[]
  ): Promise<NostrEvent[]> {
    if (this.destroyed || dTags.length === 0) return [];

    const relays = await resolveCalendarRelays([authorPubkey]);

    return this.transport.fetchDirect(
      relays,
      [
        {
          kinds,
          authors: [authorPubkey],
          '#d': dTags,
        },
      ],
      FETCH_TIMEOUT_MS,
      'calendar-foreign'
    );
  }

  private readCache(): CalendarCache | null {
    return PerAccountLocalStorage.getInstance().get<CalendarCache | null>(
      StorageKeys.CALENDAR_CACHE,
      null
    );
  }

  private writeCache(cache: CalendarCache): void {
    PerAccountLocalStorage.getInstance().set(StorageKeys.CALENDAR_CACHE, cache);
  }

  public destroy(): void {
    this.destroyed = true;
    this.fetchInFlight = null;
    CalendarDataService.resetInstance();
    // Phase 3a: drop the private list/event state as well (account switch).
    void import('./PrivateCalendarService').then(m =>
      m.PrivateCalendarService.resetInstance()
    );
  }
}
