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
import { TypedEventBus } from '../../core/TypedEventBus';
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
  /**
   * Locally imported (.ics) events not published yet — shown in the grid,
   * survive refetches and reloads, removed once published.
   */
  drafts?: CalendarEventData[];
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
  /**
   * Set by the local wipe (Reset) until the deletions are published (or the
   * session ends): relay refetches return empty so the wiped state holds
   * instead of quietly restoring what relays still have.
   */
  private localWiped = false;

  /** True between a local wipe and its publish — relay fetches are gated. */
  public isLocalWiped(): boolean {
    return this.localWiped;
  }

  /** Lift the wipe gate (called right before the publish collects data). */
  public clearLocalWipe(): void {
    this.localWiped = false;
  }

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

    // Wiped locally and not yet published: report empty without refetching —
    // staged drafts stay visible.
    if (this.localWiped) {
      return { events: [...this.getDrafts()], collections: [] };
    }

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

      const drafts = this.getDrafts();

      this.writeCache({
        version: 2,
        events: [...events, ...privateEvents],
        collections,
      });
      diagLog('system', 'calendar: own data fetched', {
        events: events.length,
        privateEvents: privateEvents.length,
        collections: collections.length,
        drafts: drafts.length,
        relays: relays.length,
      });
      // Reminders (and other listeners) rebuild from the fresh data.
      TypedEventBus.getInstance().emit('calendar:data-refreshed', {});
      return {
        events: [...events, ...privateEvents, ...drafts],
        collections,
      };
    })();

    try {
      return await this.fetchInFlight;
    } finally {
      this.fetchInFlight = null;
    }
  }

  /**
   * Local-only wipe (Reset): empty cache, saved external events, subscribed
   * collections, per-event reminder overrides + acks and dismissed invites.
   * Nothing touches relays — until the user publishes, a reload restores
   * everything. Settings (enabled flag, default lead) survive.
   */
  public wipeLocal(): void {
    this.localWiped = true;
    this.writeCache({
      version: 2,
      events: [],
      collections: [],
      drafts: [],
    });
    const storage = PerAccountLocalStorage.getInstance();
    storage.remove(StorageKeys.CALENDAR_SAVED_EVENTS);
    storage.remove(StorageKeys.CALENDAR_SUBSCRIBED_COLLECTIONS);
    storage.remove(StorageKeys.CALENDAR_EVENT_LEADS);
    storage.remove(StorageKeys.CALENDAR_REMINDER_ACKED);
    storage.remove(StorageKeys.CALENDAR_DISMISSED_INVITES);
    diagLog('system', 'calendar: local wipe');
    TypedEventBus.getInstance().emit('calendar:saved-changed', {});
  }

  /**
   * Drop one event from the per-account cache (after a delete publish) so
   * the grid is clean immediately, without waiting for relays to serve the
   * deletion back into the tombstone filter.
   */
  public removeEventFromCache(coordinate: string): void {
    const cache = this.readCache();
    if (!cache) return;
    const before = cache.events.length;
    cache.events = cache.events.filter(ev => ev.coordinate !== coordinate);
    if (cache.events.length === before) return;
    this.writeCache(cache);
    diagLog('system', 'calendar: event removed from cache', {
      coordinate: coordinate.slice(0, 40),
    });
  }

  /** Drop one collection from the per-account cache (after a delete publish). */
  public removeCollectionFromCache(coordinate: string): void {
    const cache = this.readCache();
    if (!cache) return;
    const before = cache.collections.length;
    cache.collections = cache.collections.filter(
      col => col.coordinate !== coordinate
    );
    if (cache.collections.length === before) return;
    this.writeCache(cache);
    diagLog('system', 'calendar: collection removed from cache', {
      coordinate: coordinate.slice(0, 40),
    });
  }

  // ---------- saved events ("Add to my cal", phase 2.5) ----------

  /**
   * Single public events the user imported into their grid ("Add to my cal").
   * Coordinates only — live references, re-fetched on every load, never
   * copied, never published. Locally stored per account (same model as the
   * subscribed collections).
   */
  public getSavedEventCoords(): string[] {
    return PerAccountLocalStorage.getInstance().get<string[]>(
      StorageKeys.CALENDAR_SAVED_EVENTS,
      []
    );
  }

  public isEventSaved(coordinate: string): boolean {
    return this.getSavedEventCoords().includes(coordinate);
  }

  public saveEvent(coordinate: string): void {
    const coords = this.getSavedEventCoords();
    if (!coords.includes(coordinate)) {
      coords.push(coordinate);
      PerAccountLocalStorage.getInstance().set(
        StorageKeys.CALENDAR_SAVED_EVENTS,
        coords
      );
      diagLog('system', 'calendar: event saved', {
        coordinate: coordinate.slice(0, 40),
        total: coords.length,
      });
    }
  }

  public unsaveEvent(coordinate: string): void {
    const coords = this.getSavedEventCoords().filter(c => c !== coordinate);
    PerAccountLocalStorage.getInstance().set(
      StorageKeys.CALENDAR_SAVED_EVENTS,
      coords
    );
    diagLog('system', 'calendar: event unsaved', {
      coordinate: coordinate.slice(0, 40),
      total: coords.length,
    });
  }

  /**
   * Fetch all saved public events, grouped by author (one relay query per
   * author; latest addressable version wins).
   */
  public async fetchSavedEvents(): Promise<CalendarEventData[]> {
    const coords = this.getSavedEventCoords();
    if (coords.length === 0 || this.destroyed) return [];

    const groups = new Map<
      string,
      { kinds: number[]; author: string; dTags: string[] }
    >();
    for (const coord of coords) {
      const [kindStr, author, ...rest] = coord.split(':');
      const dTag = rest.join(':');
      const kind = Number(kindStr);
      if (
        !author ||
        !dTag ||
        ![CALENDAR_EVENT_DATE_KIND, CALENDAR_EVENT_TIME_KIND].includes(kind)
      ) {
        continue;
      }
      const group = groups.get(author) ?? { kinds: [], author, dTags: [] };
      if (!group.kinds.includes(kind)) group.kinds.push(kind);
      group.dTags.push(dTag);
      groups.set(author, group);
    }

    const events: CalendarEventData[] = [];
    for (const group of groups.values()) {
      const raw = await this.fetchForeignEvents(
        group.author,
        group.kinds,
        group.dTags
      );
      const seen = new Set<string>();
      for (const ev of raw) {
        const parsed = parseCalendarEvent(ev);
        if (!parsed || seen.has(parsed.coordinate)) continue;
        seen.add(parsed.coordinate);
        events.push(parsed);
      }
    }

    if (events.length > 0) {
      diagLog('system', 'calendar: saved events fetched', {
        events: events.length,
      });
    }
    return events;
  }

  // ---------- collection subscriptions (phase 2.5) ----------

  /**
   * Subscribed public collections (kind 31924 coordinates) — live references
   * to the author's list, never copies. The grid re-reads the latest list
   * version and its referenced events on every load, so organizer updates
   * flow in automatically.
   */
  public getSubscribedCollectionCoords(): string[] {
    return PerAccountLocalStorage.getInstance().get<string[]>(
      StorageKeys.CALENDAR_SUBSCRIBED_COLLECTIONS,
      []
    );
  }

  public isCollectionSubscribed(coordinate: string): boolean {
    return this.getSubscribedCollectionCoords().includes(coordinate);
  }

  public subscribeToCollection(coordinate: string): void {
    const coords = this.getSubscribedCollectionCoords();
    if (!coords.includes(coordinate)) {
      coords.push(coordinate);
      PerAccountLocalStorage.getInstance().set(
        StorageKeys.CALENDAR_SUBSCRIBED_COLLECTIONS,
        coords
      );
      diagLog('system', 'calendar: collection subscribed', {
        coordinate,
        total: coords.length,
      });
    }
  }

  public unsubscribeFromCollection(coordinate: string): void {
    const coords = this.getSubscribedCollectionCoords().filter(
      c => c !== coordinate
    );
    PerAccountLocalStorage.getInstance().set(
      StorageKeys.CALENDAR_SUBSCRIBED_COLLECTIONS,
      coords
    );
    diagLog('system', 'calendar: collection unsubscribed', {
      coordinate,
      total: coords.length,
    });
  }

  /**
   * Fetch the latest version of every subscribed collection (31924) and all
   * calendar events they reference. Groups relay queries by (author, kind).
   */
  public async fetchSubscribedCollectionData(): Promise<{
    collections: CalendarCollectionData[];
    events: CalendarEventData[];
  }> {
    const coords = this.getSubscribedCollectionCoords();
    if (coords.length === 0 || this.destroyed) {
      return { collections: [], events: [] };
    }

    // 1. Latest 31924 per coordinate.
    const collections: CalendarCollectionData[] = [];
    const byAuthor = new Map<
      string,
      { kind: number; author: string; dTags: string[] }
    >();
    for (const coord of coords) {
      const [kindStr, author, ...rest] = coord.split(':');
      const dTag = rest.join(':');
      const kind = Number(kindStr);
      if (!author || !dTag || kind !== CALENDAR_COLLECTION_KIND) continue;
      const group = byAuthor.get(author) ?? { kind, author, dTags: [] };
      group.dTags.push(dTag);
      byAuthor.set(author, group);
    }

    for (const group of byAuthor.values()) {
      const raw = await this.fetchForeignEvents(
        group.author,
        [group.kind],
        group.dTags
      );
      // Latest version per d-tag wins (parameterized replaceable).
      const latest = new Map<string, NostrEvent>();
      for (const ev of raw) {
        const dTag = ev.tags.find(t => t[0] === 'd')?.[1] ?? '';
        const prev = latest.get(dTag);
        if (!prev || ev.created_at > prev.created_at) latest.set(dTag, ev);
      }
      for (const ev of latest.values()) {
        const parsed = parseCalendarCollection(ev);
        if (parsed) collections.push(parsed);
      }
    }

    // 2. Referenced events across all subscribed collections.
    const refs = new Set<string>();
    for (const collection of collections) {
      for (const ref of collection.eventRefs) refs.add(ref);
    }
    const events: CalendarEventData[] = [];
    const eventGroups = new Map<
      string,
      { kinds: number[]; author: string; dTags: string[] }
    >();
    for (const ref of refs) {
      const [kindStr, author, ...rest] = ref.split(':');
      const dTag = rest.join(':');
      const kind = Number(kindStr);
      if (
        !author ||
        !dTag ||
        ![CALENDAR_EVENT_DATE_KIND, CALENDAR_EVENT_TIME_KIND].includes(kind)
      ) {
        continue;
      }
      const key = `${author}`;
      const group = eventGroups.get(key) ?? { kinds: [], author, dTags: [] };
      if (!group.kinds.includes(kind)) group.kinds.push(kind);
      group.dTags.push(dTag);
      eventGroups.set(key, group);
    }
    for (const group of eventGroups.values()) {
      const raw = await this.fetchForeignEvents(
        group.author,
        group.kinds,
        group.dTags
      );
      const seen = new Set<string>();
      for (const ev of raw) {
        const parsed = parseCalendarEvent(ev);
        if (!parsed || seen.has(parsed.coordinate)) continue;
        seen.add(parsed.coordinate);
        events.push(parsed);
      }
    }

    diagLog('system', 'calendar: subscribed collections fetched', {
      collections: collections.length,
      events: events.length,
    });
    return { collections, events };
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
    // Refetch paths don't know about drafts — never drop staged imports.
    cache.drafts = cache.drafts ?? this.readCache()?.drafts ?? [];
    PerAccountLocalStorage.getInstance().set(StorageKeys.CALENDAR_CACHE, cache);
  }

  /** Locally imported events waiting to be published (may be empty). */
  public getDrafts(): CalendarEventData[] {
    return this.readCache()?.drafts ?? [];
  }

  /** Stage locally imported events; they render in the grid immediately. */
  public addDrafts(drafts: CalendarEventData[]): void {
    if (drafts.length === 0) return;
    const cache = this.readCache() ?? {
      version: 2,
      events: [],
      collections: [],
    };
    const known = new Set(
      [...(cache.drafts ?? []), ...cache.events].map(e => e.coordinate)
    );
    const fresh = drafts.filter(d => !known.has(d.coordinate));
    if (fresh.length === 0) return;
    cache.drafts = [...(cache.drafts ?? []), ...fresh];
    this.writeCache(cache);
    diagLog('system', 'calendar: drafts staged', { count: fresh.length });
  }

  /** Drop drafts after successful publish. */
  public removeDrafts(coordinates: string[]): void {
    const cache = this.readCache();
    if (!cache || (cache.drafts ?? []).length === 0) return;
    const drop = new Set(coordinates);
    cache.drafts = (cache.drafts ?? []).filter(d => !drop.has(d.coordinate));
    this.writeCache(cache);
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
