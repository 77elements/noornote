/**
 * ProfileSearchOrchestrator - Profile-specific note search
 * Handles searching through a user's notes with chunked fetching
 *
 * @orchestrator ProfileSearchOrchestrator
 * @purpose Search through user notes with client-side filtering
 * @used-by ProfileSearchComponent, SearchResultsView
 *
 * Architecture:
 * - Fetches user notes in time-chunked queries (3-month chunks)
 * - 2-stage relay strategy: read relays → outbound relays (NIP-65)
 * - Performs client-side search with AND logic
 * - Caches search results for session
 * - Provides progress callbacks for UI feedback
 */

import type { NostrEvent, NDKFilter } from '@nostr-dev-kit/ndk';
import { Orchestrator } from './Orchestrator';
import { NostrTransport } from '../transport/NostrTransport';
import { OutboundRelaysOrchestrator } from './OutboundRelaysOrchestrator';
import { SystemLogger } from '../SystemLogger';
import { diagLog } from '../DiagnosticLogger';
import { LRUCache, getCacheSize } from '../../helpers/LRUCache';

export interface SearchRequest {
  pubkeyHex: string;
  searchTerms: string;
  onProgress?: (message: string) => void;
}

export interface SearchResult {
  events: NostrEvent[];
  matchCount: number;
  totalNotes: number;
  dateRange: {
    start: string;
    end: string;
  };
}

interface CachedSearch {
  pubkeyHex: string;
  searchTerms: string;
  result: SearchResult;
}

export class ProfileSearchOrchestrator extends Orchestrator {
  private static instance: ProfileSearchOrchestrator;
  private transport: NostrTransport;
  private relayDiscovery: OutboundRelaysOrchestrator;
  private systemLogger: SystemLogger;

  /** Cache TTL: 30 minutes */
  private readonly CACHE_TTL = 30 * 60 * 1000;

  /** Search cache (per session, LRU-bounded) */
  private searchCache = new LRUCache<CachedSearch>(
    getCacheSize(20, 15, 10),
    this.CACHE_TTL
  );

  /** Fetched notes cache (per pubkey, LRU-bounded) */
  private notesCache = new LRUCache<NostrEvent[]>(
    getCacheSize(10, 8, 5),
    this.CACHE_TTL
  );

  /** In-flight note fetches per pubkey; coalesces concurrent searches before the cache fills */
  private notesFetchInProgress = new Map<string, Promise<NostrEvent[]>>();

  private constructor() {
    super('ProfileSearchOrchestrator');
    this.transport = NostrTransport.getInstance();
    this.relayDiscovery = OutboundRelaysOrchestrator.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.systemLogger.info('ProfileSearch', '🔍 Search ready to explore notes');
  }

  public static getInstance(): ProfileSearchOrchestrator {
    if (!ProfileSearchOrchestrator.instance) {
      ProfileSearchOrchestrator.instance = new ProfileSearchOrchestrator();
    }
    return ProfileSearchOrchestrator.instance;
  }

  /**
   * Search through user's notes
   */
  public async searchUserNotes(request: SearchRequest): Promise<SearchResult> {
    const { pubkeyHex, searchTerms, onProgress } = request;

    // Check cache first (TTL handled by LRUCache)
    const cacheKey = `${pubkeyHex}:${searchTerms.toLowerCase()}`;
    const cached = this.searchCache.get(cacheKey);
    if (cached) {
      this.systemLogger.info('ProfileSearch', '📦 Using cached search results');
      return cached.result;
    }

    this.systemLogger.info(
      'ProfileSearch',
      `🔍 Searching notes for: "${searchTerms}"`
    );
    onProgress?.('Preparing search...');

    try {
      // Fetch all user notes (with caching)
      const allNotes = await this.fetchAllUserNotes(pubkeyHex, onProgress);

      onProgress?.('Searching for matches...');

      // Perform client-side search
      const matchingNotes = this.searchNotes(allNotes, searchTerms);

      // Determine date range
      let dateRange = { start: 'N/A', end: 'N/A' };
      if (allNotes.length > 0) {
        const timestamps = allNotes
          .map(n => n.created_at)
          .filter((t): t is number => t !== undefined)
          .sort((a, b) => a - b);
        const formatDate = (timestamp: number) => {
          const date = new Date(timestamp * 1000);
          const month = date.toLocaleDateString('en-US', { month: 'short' });
          const day = date.getDate();
          const year = date.getFullYear();
          return `${month} ${day}, ${year}`;
        };
        const firstTimestamp = timestamps[0];
        const lastTimestamp = timestamps[timestamps.length - 1];
        if (firstTimestamp !== undefined && lastTimestamp !== undefined) {
          dateRange = {
            start: formatDate(firstTimestamp),
            end: formatDate(lastTimestamp),
          };
        }
      }

      // Sort results by date (newest first)
      matchingNotes.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));

      const result: SearchResult = {
        events: matchingNotes,
        matchCount: matchingNotes.length,
        totalNotes: allNotes.length,
        dateRange,
      };

      // Cache result
      this.searchCache.set(cacheKey, {
        pubkeyHex,
        searchTerms: searchTerms.toLowerCase(),
        result,
      });

      this.systemLogger.info(
        'ProfileSearch',
        `✨ Found ${matchingNotes.length} matching notes (${allNotes.length} total)`
      );

      return result;
    } catch (error) {
      this.systemLogger.error('ProfileSearch', `Search failed: ${String(error)}`);
      throw error;
    }
  }

  /**
   * Fetch all notes from a user (2-stage: read relays chunked → outbound relays single fetch)
   */
  private async fetchAllUserNotes(
    pubkeyHex: string,
    onProgress?: (message: string) => void
  ): Promise<NostrEvent[]> {
    // Check notes cache first (TTL handled by LRUCache)
    const cached = this.notesCache.get(pubkeyHex);
    if (cached) {
      this.systemLogger.info('ProfileSearch', '📦 Using cached user notes');
      return cached;
    }

    // Coalesce concurrent fetches for the same author so rapid searches on the
    // same profile don't each open their own relay queries before the cache fills.
    const inFlight = this.notesFetchInProgress.get(pubkeyHex);
    if (inFlight) {
      this.systemLogger.info(
        'ProfileSearch',
        '⏳ Joining in-flight note fetch'
      );
      return inFlight;
    }

    const fetchPromise = this.doFetchAllUserNotes(pubkeyHex, onProgress);
    this.notesFetchInProgress.set(pubkeyHex, fetchPromise);
    try {
      return await fetchPromise;
    } finally {
      this.notesFetchInProgress.delete(pubkeyHex);
    }
  }

  /**
   * Actual relay fetch (2-stage: read relays chunked → outbound relays single fetch).
   * Wrapped by fetchAllUserNotes for caching + concurrent-fetch coalescing.
   */
  private async doFetchAllUserNotes(
    pubkeyHex: string,
    onProgress?: (message: string) => void
  ): Promise<NostrEvent[]> {
    const allEvents = new Map<string, NostrEvent>();
    const startDate = new Date('2023-01-01');
    const endDate = new Date();

    // Split into 3-month chunks to avoid relay limits
    const chunkMonths = 3;
    const chunks: { since: number; until: number }[] = [];

    let currentDate = new Date(startDate);
    while (currentDate < endDate) {
      const chunkEnd = new Date(currentDate);
      chunkEnd.setMonth(chunkEnd.getMonth() + chunkMonths);
      if (chunkEnd > endDate) chunkEnd.setTime(endDate.getTime());

      chunks.push({
        since: Math.floor(currentDate.getTime() / 1000),
        until: Math.floor(chunkEnd.getTime() / 1000),
      });

      currentDate = new Date(chunkEnd);
      currentDate.setDate(currentDate.getDate() + 1);
    }

    onProgress?.(`Fetching notes in ${chunks.length} time chunks...`);

    // Stage 1: Read relays (chunked)
    const relays = this.transport.getReadRelays();

    for (const [i, chunk] of chunks.entries()) {
      const formatDate = (timestamp: number) => {
        const date = new Date(timestamp * 1000);
        return date.toLocaleDateString('en-US', {
          month: 'short',
          year: 'numeric',
        });
      };
      const chunkStart = formatDate(chunk.since);
      const chunkEnd = formatDate(chunk.until);

      onProgress?.(
        `Chunk ${i + 1}/${chunks.length} (${chunkStart} - ${chunkEnd})`
      );

      const filters: NDKFilter[] = [
        {
          kinds: [1], // Text notes only
          authors: [pubkeyHex],
          since: chunk.since,
          until: chunk.until,
          limit: 500,
        },
      ];

      try {
        const events = await this.transport.fetch(
          relays,
          filters,
          5000,
          false,
          'ProfileSearchOrch'
        );

        // Deduplicate
        events.forEach(event => {
          const eventId = event.id;
          if (eventId && !allEvents.has(eventId)) {
            allEvents.set(eventId, event);
          }
        });

        // Small delay to be nice to relays
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        this.systemLogger.warn(
          'ProfileSearch',
          `Chunk ${i + 1} failed: ${String(error)}`
        );
      }
    }

    // Stage 2: Outbound relays (single fetch, no chunking)
    // Catches notes that only exist on the user's own NIP-65 write relays
    const countBeforeOutbound = allEvents.size;
    onProgress?.('Checking author relays for additional notes...');

    try {
      const outboundRelays = await this.relayDiscovery.getCombinedRelays(
        [pubkeyHex],
        true
      );

      const outboundFilters: NDKFilter[] = [
        {
          kinds: [1],
          authors: [pubkeyHex],
          limit: 5000,
        },
      ];

      const outboundEvents = await this.transport.fetch(
        outboundRelays,
        outboundFilters,
        10000,
        true,
        'ProfileSearchOrch'
      );

      outboundEvents.forEach(event => {
        const eventId = event.id;
        if (eventId && !allEvents.has(eventId)) {
          allEvents.set(eventId, event);
        }
      });

      const newFromOutbound = allEvents.size - countBeforeOutbound;
      if (newFromOutbound > 0) {
        diagLog(
          'relays',
          'ProfileSearchOrchestrator: outbound fallback found additional notes',
          {
            pubkey: pubkeyHex.slice(0, 8),
            newNotes: newFromOutbound,
          }
        );
      }
    } catch (error) {
      this.systemLogger.warn(
        'ProfileSearch',
        `Outbound relay fetch failed: ${String(error)}`
      );
    }

    onProgress?.('Processing notes...');

    const notes = Array.from(allEvents.values());

    // Cache notes
    this.notesCache.set(pubkeyHex, notes);

    return notes;
  }

  /**
   * Search notes with AND logic (all terms must be present)
   */
  private searchNotes(notes: NostrEvent[], searchTerms: string): NostrEvent[] {
    const terms = searchTerms
      .toLowerCase()
      .split(/\s+/)
      .filter(term => term.length > 0);

    if (terms.length === 0) {
      return notes;
    }

    return notes.filter(note => {
      const content = note.content.toLowerCase();
      // AND logic: all terms must be present
      return terms.every(term => content.includes(term));
    });
  }

  /**
   * Clear search cache for a specific pubkey
   */
  public clearCacheForPubkey(pubkeyHex: string): void {
    // Clear notes cache
    this.notesCache.delete(pubkeyHex);

    // Clear search results cache for this pubkey
    const keysToDelete: string[] = [];
    this.searchCache.forEach((cached, key) => {
      if (cached.pubkeyHex === pubkeyHex) {
        keysToDelete.push(key);
      }
    });
    keysToDelete.forEach(key => this.searchCache.delete(key));

    this.systemLogger.info('ProfileSearch', '🗑️ Cache cleared for user');
  }

  /**
   * Clear all caches
   */
  public clearAllCaches(): void {
    this.searchCache.clear();
    this.notesCache.clear();
    this.systemLogger.info('ProfileSearch', '🗑️ All caches cleared');
  }

  // Orchestrator interface implementations (required by base class)

  public onui(_data: any): void {
    // Handle UI actions if needed
  }

  public onopen(_relay: string): void {
    // Not used for search (fetch-only)
  }

  public onmessage(_relay: string, _event: NostrEvent): void {
    // Not used for search (fetch-only)
  }

  public onerror(relay: string, error: Error): void {
    this.systemLogger.error(
      'ProfileSearch',
      `Relay error (${relay}): ${error.message}`
    );
  }

  public onclose(_relay: string): void {
    // Not used for search (fetch-only)
  }

  public override destroy(): void {
    this.clearAllCaches();
    super.destroy();
    this.systemLogger.info('ProfileSearch', 'Search orchestrator destroyed');
  }
}
