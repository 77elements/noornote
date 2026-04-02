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
 * - Memory-only LRU cache (via LRUCache helper)
 * - Platform-aware size: Desktop > Web > Mobile
 * - Evicts oldest entries when cache exceeds limit
 */

import type { NostrEvent, NDKFilter } from '@nostr-dev-kit/ndk';
import { NostrTransport } from './transport/NostrTransport';
import { RelayConfig } from './RelayConfig';
import { LRUCache, getCacheSize } from '../helpers/LRUCache';

export interface CachedNote {
  event: NostrEvent;
  fetchedAt: number;
}

export class NoteService {
  private static instance: NoteService;

  /** LRU Note cache (event.id → CachedNote) */
  private cache = new LRUCache<CachedNote>(getCacheSize(2000, 1000, 500));

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
   * Get a single note by ID
   * Returns from cache if available, fetches from relays otherwise
   */
  public async getNote(eventId: string): Promise<NostrEvent | null> {
    // Check cache (LRU touch handled by LRUCache.get())
    const cached = this.cache.get(eventId);
    if (cached) {
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
        this.cache.set(eventId, {
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

    // Check cache first (LRU touch handled by LRUCache.get())
    for (const id of eventIds) {
      const cached = this.cache.get(id);
      if (cached) {
        result.set(id, cached.event);
      } else {
        toFetch.push(id);
      }
    }

    // Fetch missing notes
    if (toFetch.length > 0) {
      const fetched = await this.fetchMultipleFromRelays(toFetch);
      fetched.forEach((event, id) => {
        this.cache.set(id, {
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
      this.cache.set(event.id, {
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
    return { size: this.cache.size, maxSize: getCacheSize(2000, 1000, 500) };
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
