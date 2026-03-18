/**
 * NoteService - Central Note Cache & Fetching
 * Single source of truth for all notes in the app
 *
 * Usage:
 * - Components call getNote(id) or getNotes(ids)
 * - FeedOrchestrator calls registerNotes() after loading
 * - Other orchestrators check cache before fetching
 *
 * LRU CACHE STRATEGY:
 * - Memory-only cache with LRU eviction
 * - Evicts oldest entries when cache exceeds MAX_CACHE_SIZE
 */

import type { NostrEvent, NDKFilter } from '@nostr-dev-kit/ndk';
import { NostrTransport } from './transport/NostrTransport';
import { RelayConfig } from './RelayConfig';

export interface CachedNote {
  event: NostrEvent;
  fetchedAt: number;
}

export class NoteService {
  private static instance: NoteService;

  /** LRU Note cache (event.id → CachedNote) */
  private cache: Map<string, CachedNote> = new Map();
  private readonly MAX_CACHE_SIZE = 2000;

  /** Deduplication for parallel fetches */
  private fetchingNotes: Map<string, Promise<NostrEvent | null>> = new Map();

  private transport: NostrTransport;
  private relayConfig: RelayConfig;

  private constructor() {
    this.transport = NostrTransport.getInstance();
    this.relayConfig = RelayConfig.getInstance();
  }

  public static getInstance(): NoteService {
    if (!NoteService.instance) {
      NoteService.instance = new NoteService();
    }
    return NoteService.instance;
  }

  /**
   * LRU: Move key to end (most recent) and evict oldest if over limit
   */
  private setCacheEntry(id: string, entry: CachedNote): void {
    // Re-insert to move to end (LRU)
    if (this.cache.has(id)) {
      this.cache.delete(id);
    }

    // Evict oldest entries if cache is full
    while (this.cache.size >= this.MAX_CACHE_SIZE) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(id, entry);
  }

  /**
   * Get a single note by ID
   * Returns from cache if available, fetches from relays otherwise
   */
  public async getNote(eventId: string): Promise<NostrEvent | null> {
    // Check cache
    const cached = this.cache.get(eventId);
    if (cached) {
      // LRU touch: move to end
      this.cache.delete(eventId);
      this.cache.set(eventId, cached);
      return cached.event;
    }

    // Deduplicate parallel requests
    if (this.fetchingNotes.has(eventId)) {
      return this.fetchingNotes.get(eventId)!;
    }

    // Fetch from relays
    const fetchPromise = this.fetchFromRelays(eventId);
    this.fetchingNotes.set(eventId, fetchPromise);

    try {
      const event = await fetchPromise;
      if (event) {
        this.setCacheEntry(eventId, {
          event,
          fetchedAt: Date.now()
        });
      }
      return event;
    } finally {
      this.fetchingNotes.delete(eventId);
    }
  }

  /**
   * Get multiple notes efficiently (batch fetch)
   * Returns cached notes immediately, fetches missing ones
   */
  public async getNotes(eventIds: string[]): Promise<Map<string, NostrEvent>> {
    const result = new Map<string, NostrEvent>();
    const toFetch: string[] = [];

    // Check cache first
    for (const id of eventIds) {
      const cached = this.cache.get(id);
      if (cached) {
        // LRU touch
        this.cache.delete(id);
        this.cache.set(id, cached);
        result.set(id, cached.event);
      } else {
        toFetch.push(id);
      }
    }

    // Fetch missing notes
    if (toFetch.length > 0) {
      const fetched = await this.fetchMultipleFromRelays(toFetch);
      fetched.forEach((event, id) => {
        this.setCacheEntry(id, {
          event,
          fetchedAt: Date.now()
        });
        result.set(id, event);
      });
    }

    return result;
  }

  /**
   * Register a note (e.g., from Timeline loading)
   * Other components can then access it without fetching
   */
  public registerNote(event: NostrEvent): void {
    if (event.id && !this.cache.has(event.id)) {
      this.setCacheEntry(event.id, {
        event,
        fetchedAt: Date.now()
      });
    }
  }

  /**
   * Register multiple notes (e.g., from FeedOrchestrator batch load)
   */
  public registerNotes(events: NostrEvent[]): void {
    for (const event of events) {
      this.registerNote(event);
    }
  }

  /**
   * Check if note is cached (without fetching)
   */
  public hasNote(eventId: string): boolean {
    return this.cache.has(eventId);
  }

  /**
   * Get cached note (without fetching)
   */
  public getCachedNote(eventId: string): NostrEvent | null {
    return this.cache.get(eventId)?.event || null;
  }

  /**
   * Invalidate cached note (e.g., after deletion)
   */
  public invalidateNote(eventId: string): void {
    this.cache.delete(eventId);
  }

  /**
   * Clear all cached notes
   */
  public clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache stats (for debugging)
   */
  public getCacheStats(): { size: number; maxSize: number } {
    return { size: this.cache.size, maxSize: this.MAX_CACHE_SIZE };
  }

  /**
   * Fetch single note from relays
   */
  private async fetchFromRelays(eventId: string): Promise<NostrEvent | null> {
    const relays = this.relayConfig.getAggregatorRelays();

    const filters: NDKFilter[] = [{
      ids: [eventId],
      limit: 1
    }];

    try {
      const events = await this.transport.fetch(relays, filters, 5000, false, 'NoteService');
      return events[0] || null;
    } catch (error) {
      console.warn(`NoteService: Failed to fetch note ${eventId}:`, error);
      return null;
    }
  }

  /**
   * Fetch multiple notes from relays
   */
  private async fetchMultipleFromRelays(eventIds: string[]): Promise<Map<string, NostrEvent>> {
    const result = new Map<string, NostrEvent>();
    const relays = this.relayConfig.getAggregatorRelays();

    const filters: NDKFilter[] = [{
      ids: eventIds
    }];

    try {
      const events = await this.transport.fetch(relays, filters, 5000, false, 'NoteService');
      for (const event of events) {
        if (event.id) {
          result.set(event.id, event);
        }
      }
    } catch (error) {
      console.warn(`NoteService: Failed to fetch notes:`, error);
    }

    return result;
  }
}
