/**
 * ReactionsOrchestrator - Interaction Stats Management
 * Handles reactions, reposts, replies, and zaps for notes
 *
 * @orchestrator ReactionsOrchestrator
 * @purpose Fetch and cache interaction stats for notes (ISL)
 * @used-by InteractionStatusLine (SNV live, Timeline cached)
 *
 * Architecture:
 * - Replaces InteractionStatsService
 * - Uses NostrTransport for all subscriptions
 * - Cache: 5min TTL, max 200 entries, periodic eviction sweep
 * - Fetches reactions, reposts, replies, zaps in parallel
 */

import type { NostrEvent, NDKFilter } from '@nostr-dev-kit/ndk';
import { Orchestrator } from './Orchestrator';
import { NostrTransport } from '../transport/NostrTransport';
import { RelayConfig } from '../RelayConfig';
import { parseBolt11Amount } from '../../helpers/zapUtils';
import { SystemLogger } from '../SystemLogger';
import { UserProfileService } from '../UserProfileService';
import { isUserMuted } from '../../lists/mutes';

/**
 * Count replies excluding events authored by users the current user has
 * muted. Mirrors the rendering side: muted authors' replies don't show
 * in the thread, so they shouldn't show in the ISL counter either.
 */
function countVisibleReplies(events: NostrEvent[]): number {
  return events.filter(e => !isUserMuted(e.pubkey).any).length;
}

export interface InteractionStats {
  replies: number;
  reposts: number;
  quotedReposts: number;
  likes: number;
  zaps: number;
  lastUpdated: number;
}

export interface DetailedStats {
  replyEvents: NostrEvent[];
  repostEvents: NostrEvent[];
  quotedEvents: NostrEvent[];
  reactionEvents: NostrEvent[];
  zapEvents: NostrEvent[];
  lastUpdated: number;
}

export interface LiveReactionsOptions {
  interval?: number;  // Polling interval in ms (default: 30000 = 30s)
}

export class ReactionsOrchestrator extends Orchestrator {
  private static instance: ReactionsOrchestrator;
  private transport: NostrTransport;
  private systemLogger: SystemLogger;

  /** Single source of truth: Detailed stats cache (5min TTL, max 200 entries) */
  private detailedStatsCache: Map<string, DetailedStats> = new Map();
  private fetchingDetailedStats: Map<string, Promise<DetailedStats>> = new Map();

  private cacheDuration = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_STATS_CACHE_SIZE = 200;
  private readonly MAX_AUX_CACHE_SIZE = 500;

  /** Eviction sweep interval */
  private evictionTimer: number | null = null;
  private static readonly EVICTION_INTERVAL = 60_000; // 60 seconds

  /** Fetch counter for logging (first = original note, others = replies) */
  private fetchCounter = 0;

  /** Author pubkey cache for Hollywood-style logging (bounded) */
  private authorPubkeyCache: Map<string, string> = new Map();

  /**
   * Event ID cache for long-form articles (addressable events)
   * Long-form articles use addressable identifier (kind:pubkey:d-tag) but some clients
   * reference them by event ID. We need to search BOTH to find all interactions.
   */
  private articleEventIdCache: Map<string, string> = new Map();

  /** Live reactions polling tracking */
  private reactionIntervals: Map<string, number> = new Map(); // noteId → intervalId
  private lastReactionFetch: Map<string, number> = new Map(); // noteId → timestamp

  private constructor() {
    super('ReactionsOrchestrator');
    this.transport = NostrTransport.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.systemLogger.info('ReactionsOrchestrator', 'Reactions Orchestrator at your service');

    // Start periodic eviction sweep
    this.evictionTimer = window.setInterval(() => this.evictExpiredEntries(), ReactionsOrchestrator.EVICTION_INTERVAL);
  }

  public static getInstance(): ReactionsOrchestrator {
    if (!ReactionsOrchestrator.instance) {
      ReactionsOrchestrator.instance = new ReactionsOrchestrator();
    }
    return ReactionsOrchestrator.instance;
  }

  /**
   * Evict expired cache entries and enforce size limits
   */
  private evictExpiredEntries(): void {
    const now = Date.now();

    // Evict expired detailedStatsCache entries
    for (const [noteId, stats] of this.detailedStatsCache) {
      if (now - stats.lastUpdated > this.cacheDuration) {
        this.detailedStatsCache.delete(noteId);
      }
    }

    // Enforce max size on detailedStatsCache (evict oldest)
    if (this.detailedStatsCache.size > this.MAX_STATS_CACHE_SIZE) {
      const entries = [...this.detailedStatsCache.entries()]
        .sort((a, b) => a[1].lastUpdated - b[1].lastUpdated);
      const toRemove = entries.length - this.MAX_STATS_CACHE_SIZE;
      for (let i = 0; i < toRemove; i++) {
        this.detailedStatsCache.delete(entries[i]![0]);
      }
    }

    // Enforce max size on auxiliary caches
    this.trimMap(this.authorPubkeyCache, this.MAX_AUX_CACHE_SIZE);
    this.trimMap(this.articleEventIdCache, this.MAX_AUX_CACHE_SIZE);
  }

  /**
   * Trim a Map to maxSize by removing oldest entries (first inserted)
   */
  private trimMap(map: Map<string, string>, maxSize: number): void {
    if (map.size <= maxSize) return;
    const iterator = map.keys();
    let toRemove = map.size - maxSize;
    while (toRemove > 0) {
      const key = iterator.next().value;
      if (key) map.delete(key);
      toRemove--;
    }
  }

  /**
   * Check if noteId is a long-form article (addressable event)
   * Format: "kind:pubkey:d-tag" (e.g., "30023:abc123...:my-article")
   * Normal notes are just hex event IDs without colons
   */
  private isLongFormArticle(noteId: string): boolean {
    return noteId.includes(':');
  }

  /**
   * Get stats for a note (with caching)
   * @param noteId - The note ID to fetch stats for (addressable identifier or event ID)
   * @param authorPubkey - Optional author pubkey for Hollywood-style logging
   * @param eventId - Optional event ID for long-form articles (to search both #a and #e)
   *
   * IMPLEMENTATION: Fetches DetailedStats and extracts counts
   * Single source of truth - no duplicate fetch logic
   */
  public async getStats(noteId: string, authorPubkey?: string, eventId?: string): Promise<InteractionStats> {
    // Validate noteId early - skip synthetic IDs
    if (!this.isValidNoteId(noteId)) {
      return {
        replies: 0,
        reposts: 0,
        quotedReposts: 0,
        likes: 0,
        zaps: 0,
        lastUpdated: Date.now()
      };
    }

    // Cache author pubkey for logging
    if (authorPubkey) {
      this.authorPubkeyCache.set(noteId, authorPubkey);
    }

    // For long-form articles: cache event ID to search both #a and #e tags
    if (eventId && this.isLongFormArticle(noteId)) {
      this.articleEventIdCache.set(noteId, eventId);
    }

    // Fetch detailed stats (uses cache if available)
    const detailedStats = await this.getDetailedStats(noteId, eventId);

    // Extract counts from detailed stats
    return {
      replies: countVisibleReplies(detailedStats.replyEvents),
      reposts: detailedStats.repostEvents.length,
      quotedReposts: detailedStats.quotedEvents.length,
      likes: detailedStats.reactionEvents.length,
      zaps: this.calculateTotalZaps(detailedStats.zapEvents),
      lastUpdated: detailedStats.lastUpdated
    };
  }

  /**
   * Get cached stats for a note (without fetching)
   * Returns null if not in cache or expired
   * Used by Timeline to show previously-fetched stats from SNV
   */
  public getCachedStats(noteId: string): InteractionStats | null {
    const cached = this.detailedStatsCache.get(noteId);
    if (cached && Date.now() - cached.lastUpdated < this.cacheDuration) {
      this.systemLogger.info('ReactionsOrch', '💾 ISL stats loaded from Single Note View');
      return {
        replies: countVisibleReplies(cached.replyEvents),
        reposts: cached.repostEvents.length,
        quotedReposts: cached.quotedEvents.length,
        likes: cached.reactionEvents.length,
        zaps: this.calculateTotalZaps(cached.zapEvents),
        lastUpdated: cached.lastUpdated
      };
    }
    return null;
  }

  /**
   * Get detailed stats for a note (with full event arrays)
   * Used by Analytics Modal to show detailed breakdowns
   * @param noteId - The note ID (addressable identifier or event ID)
   * @param eventId - Optional event ID for long-form articles (to search both #a and #e)
   */
  public async getDetailedStats(noteId: string, eventId?: string): Promise<DetailedStats> {
    // Validate noteId - must be 64-char hex OR naddr (long-form)
    // Skip synthetic IDs like "mutual-mutual_unfollow-..."
    if (!this.isValidNoteId(noteId)) {
      return {
        replyEvents: [],
        repostEvents: [],
        quotedEvents: [],
        reactionEvents: [],
        zapEvents: [],
        lastUpdated: Date.now()
      };
    }

    // For long-form articles: cache event ID if provided
    if (eventId && this.isLongFormArticle(noteId)) {
      this.articleEventIdCache.set(noteId, eventId);
    }

    // Check cache first
    const cached = this.detailedStatsCache.get(noteId);
    if (cached && Date.now() - cached.lastUpdated < this.cacheDuration) {
      this.systemLogger.info('ReactionsOrch', '💾 Detailed stats loaded from cache');
      return cached;
    }

    // If already fetching, wait for that request
    if (this.fetchingDetailedStats.has(noteId)) {
      this.systemLogger.info('ReactionsOrch', '⏳ Detailed stats loading...');
      return await this.fetchingDetailedStats.get(noteId)!;
    }

    // For long-form articles: get cached eventId if not provided
    const articleEventId = this.isLongFormArticle(noteId)
      ? (eventId || this.articleEventIdCache.get(noteId))
      : undefined;

    // Start new fetch
    const fetchPromise = this.fetchDetailedStatsFromRelays(noteId, articleEventId);
    this.fetchingDetailedStats.set(noteId, fetchPromise);

    try {
      const stats = await fetchPromise;
      this.detailedStatsCache.set(noteId, stats);
      return stats;
    } finally {
      this.fetchingDetailedStats.delete(noteId);
    }
  }

  /**
   * Reset fetch counter (called when entering SNV)
   */
  public resetFetchCounter(): void {
    this.fetchCounter = 0;
  }

  /**
   * Calculate total zaps in sats from zap events
   */
  private calculateTotalZaps(zapEvents: NostrEvent[]): number {
    return zapEvents.reduce((total, event) => {
      const bolt11Tag = event.tags.find(tag => tag[0] === 'bolt11');
      return bolt11Tag?.[1] ? total + parseBolt11Amount(bolt11Tag[1]) : total;
    }, 0);
  }

  /**
   * Fetch detailed stats from relays (all types in parallel, full events)
   * SINGLE SOURCE OF TRUTH - both ISL and Analytics Modal use this
   * @param noteId - The note ID (addressable identifier or event ID)
   * @param articleEventId - For long-form articles only: event ID to search both #a and #e
   */
  private async fetchDetailedStatsFromRelays(noteId: string, articleEventId?: string): Promise<DetailedStats> {
    // Increment counter and determine context
    this.fetchCounter++;
    const isOriginalNote = this.fetchCounter === 1;

    // Build context message with username for original note
    let fetchingMessage: string;
    let readyMessage: string;

    if (isOriginalNote) {
      const authorPubkey = this.authorPubkeyCache.get(noteId);
      if (authorPubkey) {
        const profileService = UserProfileService.getInstance();
        const username = profileService.getUsername(authorPubkey);
        if (username) {
          const displayName = username.length > 10 ? username.substring(0, 10) + '..' : username;
          fetchingMessage = `📊 Fetching interaction stats from relays for ${displayName}'s note...`;
          readyMessage = `📊 Interaction stats ready for ${displayName}'s note`;
        } else {
          fetchingMessage = '📊 Fetching interaction stats from relays for this note...';
          readyMessage = '📊 Interaction stats ready for this note';
        }
      } else {
        fetchingMessage = '📊 Fetching interaction stats from relays for this note...';
        readyMessage = '📊 Interaction stats ready for this note';
      }
    } else {
      const replyNum = this.fetchCounter - 1;
      fetchingMessage = `📊 Fetching interaction stats from relays for reply #${replyNum}`;
      readyMessage = `Interaction stats for reply #${replyNum}: Loaded ✅`;
    }

    this.systemLogger.info('ReactionsOrch', fetchingMessage);

    const detailedStats: DetailedStats = {
      replyEvents: [],
      repostEvents: [],
      quotedEvents: [],
      reactionEvents: [],
      zapEvents: [],
      lastUpdated: Date.now()
    };

    // Fetch all interaction types in parallel
    const [reactions, reposts, replies, zaps] = await Promise.all([
      this.fetchReactionEvents(noteId, articleEventId),
      this.fetchRepostEvents(noteId, articleEventId),
      this.fetchReplyEvents(noteId, articleEventId),
      this.fetchZapEvents(noteId, articleEventId)
    ]);

    detailedStats.reactionEvents = reactions;
    detailedStats.repostEvents = reposts.regular;
    detailedStats.quotedEvents = reposts.quoted;
    detailedStats.replyEvents = replies;
    detailedStats.zapEvents = zaps;

    this.systemLogger.info('ReactionsOrch', readyMessage);

    return detailedStats;
  }


  /**
   * Build NDK filters for fetching interaction events
   * Handles both normal notes (#e tag) and long-form articles (#a and #e tags)
   */
  private buildFilters(kinds: number[], noteId: string, articleEventId?: string): NDKFilter[] {
    const filters: NDKFilter[] = [];
    const isArticle = this.isLongFormArticle(noteId);

    if (isArticle) {
      filters.push({ kinds, '#a': [noteId] });
      if (articleEventId) {
        filters.push({ kinds, '#e': [articleEventId] });
      }
    } else {
      filters.push({ kinds, '#e': [noteId] });
    }

    return filters;
  }

  /**
   * Build NDK filters specifically for reply counting (kind:1 NIP-10 + kind:1111 NIP-22).
   * Adds uppercase root-tag variants (#E / #A) on top of the regular parent-tag filters
   * so that nested NIP-22 replies (which reference the root via uppercase tags) count
   * toward the original note's total — not just direct replies.
   */
  private buildReplyFilters(kinds: number[], noteId: string, articleEventId?: string): NDKFilter[] {
    const filters: NDKFilter[] = this.buildFilters(kinds, noteId, articleEventId);
    const isArticle = this.isLongFormArticle(noteId);

    if (isArticle) {
      filters.push({ kinds, '#A': [noteId] });
      if (articleEventId) {
        filters.push({ kinds, '#E': [articleEventId] });
      }
    } else {
      filters.push({ kinds, '#E': [noteId] });
    }

    return filters;
  }

  /**
   * Resolve the relay set to query for reactions / reposts / replies
   * targeting a given note. Same problem as
   * `NotificationsOrchestrator.getReadRelays`: reactors are unknown in
   * advance, and unioning every follow's outbound-set explodes the
   * browser's WebSocket-per-origin limit.
   *
   * Bounded set: own NIP-65 read-relays + aggregator-relays. Covers
   * mainstream reactors; misses the private-relay-only-reactor edge
   * case (accepted gap, mirrors Amethyst behaviour).
   */
  private async getReactionFetchRelays(): Promise<string[]> {
    const relayConfig = RelayConfig.getInstance();
    const set = new Set<string>(this.transport.getReadRelays());
    relayConfig.getAggregatorRelays().forEach((r: string) => set.add(r));
    return [...set];
  }

  /**
   * Fetch reaction events (kind 7) - returns full events for Analytics Modal
   * Per NIP-25: ALL content values are valid (emojis, +, -, custom emoji)
   *
   * NORMAL NOTES: Search #e tag only (unchanged behavior)
   * LONG-FORM ARTICLES: Search BOTH #a and #e tags (some clients use event ID)
   */
  private async fetchReactionEvents(noteId: string, articleEventId?: string): Promise<NostrEvent[]> {
    const reactions: NostrEvent[] = [];
    const seenAuthors = new Set<string>();
    const relays = await this.getReactionFetchRelays();
    const filters = this.buildFilters([7], noteId, articleEventId);

    return new Promise((resolve) => {
      let timeout: ReturnType<typeof setTimeout>;
      this.transport.subscribe(relays, filters, {
        onEvent: (event: NostrEvent) => {
          // Only store one reaction per author (latest one)
          // Accept ALL reactions per NIP-25 (any emoji or content value)
          if (!seenAuthors.has(event.pubkey)) {
            reactions.push(event);
            seenAuthors.add(event.pubkey);
          }
        },
        onEose: () => {
          clearTimeout(timeout);
          resolve(reactions);
        }
      }).then(sub => {
        timeout = setTimeout(() => { sub.close(); resolve(reactions); }, 5000);
      });
    });
  }

  /**
   * Fetch repost events - returns separate arrays for regular/quoted
   * Regular reposts: kind:6 with #e or #a tag
   * Quoted reposts: kind:1 with #q tag
   *
   * NORMAL NOTES: Search #e and #q tags only (unchanged behavior)
   * LONG-FORM ARTICLES: Search BOTH #a and #e tags, #q uses event ID
   */
  private async fetchRepostEvents(noteId: string, articleEventId?: string): Promise<{ regular: NostrEvent[]; quoted: NostrEvent[] }> {
    const regular: NostrEvent[] = [];
    const quoted: NostrEvent[] = [];
    const regularAuthors = new Set<string>();
    const quotedAuthors = new Set<string>();
    const relays = await this.getReactionFetchRelays();

    const isArticle = this.isLongFormArticle(noteId);

    // Build filters - reposts need special handling for #q tag
    const filters: NDKFilter[] = this.buildFilters([6, 16], noteId, articleEventId);

    // Add quoted repost filters (#q tag)
    if (isArticle) {
      if (articleEventId) {
        filters.push({ kinds: [1], '#q': [articleEventId] });
      }
    } else {
      filters.push({ kinds: [1], '#q': [noteId] });
    }

    return new Promise((resolve) => {
      let timeout: ReturnType<typeof setTimeout>;
      this.transport.subscribe(relays, filters, {
        onEvent: (event: NostrEvent) => {
          if (event.kind === 6 || event.kind === 16) {
            if (!regularAuthors.has(event.pubkey)) {
              regularAuthors.add(event.pubkey);
              regular.push(event);
            }
          } else if (event.kind === 1) {
            if (!quotedAuthors.has(event.pubkey)) {
              quotedAuthors.add(event.pubkey);
              quoted.push(event);
            }
          }
        },
        onEose: () => {
          clearTimeout(timeout);
          resolve({ regular, quoted });
        }
      }).then(sub => {
        timeout = setTimeout(() => { sub.close(); resolve({ regular, quoted }); }, 5000);
      });
    });
  }

  /**
   * Fetch reply events (kind 1) - returns full events for Analytics Modal
   * COUNTS ALL REPLIES including nested (replies to replies)
   * A reply references our note with ANY e-tag (root, reply, or mention) or a-tag
   *
   * NORMAL NOTES: Search #e tag only (unchanged behavior)
   * LONG-FORM ARTICLES: Search BOTH #a and #e tags
   */
  private async fetchReplyEvents(noteId: string, articleEventId?: string): Promise<NostrEvent[]> {
    const replies: NostrEvent[] = [];
    const seenReplyIds = new Set<string>();
    const relays = await this.getReactionFetchRelays();
    const isArticle = this.isLongFormArticle(noteId);
    // Include kind:1 (NIP-10 replies) AND kind:1111 (NIP-22 comments).
    // NIP-22 is mandatory for replies to addressable events (articles, NIP-34 Git
    // events) and increasingly used for kind:1 replies as well.
    //
    // Filter on BOTH lowercase and uppercase root tags so the count includes
    // direct + nested replies. NIP-22 nested replies reference the parent via
    // lowercase (e/a) and the root via uppercase (E/A) — without #E/#A the count
    // would only show direct replies.
    const filters = this.buildReplyFilters([1, 1111], noteId, articleEventId);

    return new Promise((resolve) => {
      let timeout: ReturnType<typeof setTimeout>;
      this.transport.subscribe(relays, filters, {
        onEvent: (event: NostrEvent) => {
          if (!event.id || seenReplyIds.has(event.id)) return;

          // Verify the event actually references our note. Accept both lowercase
          // (parent — direct reply) and uppercase (root — nested NIP-22 reply) tags.
          const referencesNote = isArticle
            ? event.tags.some(tag =>
                ((tag[0] === 'a' || tag[0] === 'A') && tag[1] === noteId) ||
                (articleEventId && (tag[0] === 'e' || tag[0] === 'E') && tag[1] === articleEventId)
              )
            : event.tags.some(tag => (tag[0] === 'e' || tag[0] === 'E') && tag[1] === noteId);

          if (referencesNote) {
            replies.push(event);
            seenReplyIds.add(event.id);
          }
        },
        onEose: () => {
          clearTimeout(timeout);
          resolve(replies);
        }
      }).then(sub => {
        timeout = setTimeout(() => { sub.close(); resolve(replies); }, 5000);
      });
    });
  }

  /**
   * Fetch zap events (kind 9735) - returns full events for Analytics Modal
   *
   * NORMAL NOTES: Search #e tag only (unchanged behavior)
   * LONG-FORM ARTICLES: Search BOTH #a and #e tags
   */
  private async fetchZapEvents(noteId: string, articleEventId?: string): Promise<NostrEvent[]> {
    const zaps: NostrEvent[] = [];
    const seenZapIds = new Set<string>();
    const relays = await this.getReactionFetchRelays();
    const filters = this.buildFilters([9735], noteId, articleEventId);

    return new Promise((resolve) => {
      let timeout: ReturnType<typeof setTimeout>;
      this.transport.subscribe(relays, filters, {
        onEvent: (event: NostrEvent) => {
          if (!event.id || seenZapIds.has(event.id)) return;

          const bolt11Tag = event.tags.find(tag => tag[0] === 'bolt11');
          if (bolt11Tag?.[1]) {
            zaps.push(event);
            seenZapIds.add(event.id);
          }
        },
        onEose: () => {
          clearTimeout(timeout);
          resolve(zaps);
        }
      }).then(sub => {
        timeout = setTimeout(() => { sub.close(); resolve(zaps); }, 8000);
      });
    });
  }

  /**
   * Update cached stats for a note (used by SNV to correct reply count)
   * SNV counts all replies including nested, ReactionsOrchestrator only counts direct replies
   * NOTE: Only updates count-based fields, not the event arrays
   */
  public updateCachedStats(noteId: string, _updates: Partial<InteractionStats>): void {
    const cached = this.detailedStatsCache.get(noteId);
    if (cached) {
      // Update lastUpdated timestamp when modifying stats
      cached.lastUpdated = Date.now();
      // NOTE: We don't modify event arrays - only the counts derived from getStats() will reflect updates
      this.detailedStatsCache.set(noteId, cached);
    }
  }

  /**
   * Batch-fetch stats for multiple notes in a single relay round-trip.
   * Skips already-cached and invalid IDs. Articles (addressable events) are excluded
   * because they need #a-tag filters that can't be batched with normal #e-tag notes.
   */
  public async batchFetchStats(noteIds: string[]): Promise<Map<string, InteractionStats>> {
    const result = new Map<string, InteractionStats>();

    const uncachedIds = noteIds.filter(id => {
      if (!this.isValidNoteId(id) || this.isLongFormArticle(id)) return false;
      const cached = this.getCachedStats(id);
      if (cached) { result.set(id, cached); return false; }
      return true;
    });

    if (uncachedIds.length === 0) return result;

    const relays = await this.getReactionFetchRelays();
    const collectors = new Map<string, DetailedStats>();
    for (const id of uncachedIds) {
      collectors.set(id, {
        replyEvents: [], repostEvents: [], quotedEvents: [],
        reactionEvents: [], zapEvents: [], lastUpdated: Date.now()
      });
    }

    const filters: NDKFilter[] = [
      { kinds: [7], '#e': uncachedIds },
      { kinds: [6, 16], '#e': uncachedIds },
      { kinds: [1, 1111], '#e': uncachedIds },
      { kinds: [1], '#q': uncachedIds },
      { kinds: [9735], '#e': uncachedIds },
    ];

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 8000);
      this.transport.subscribe(relays, filters, {
        onEvent: (event: NostrEvent) => {
          const qTag = event.tags.find(tag => tag[0] === 'q' && collectors.has(tag[1]!));
          if (qTag) {
            collectors.get(qTag[1]!)!.quotedEvents.push(event);
            return;
          }
          const eTag = event.tags.find(tag => tag[0] === 'e' && collectors.has(tag[1]!));
          if (!eTag) return;
          const stats = collectors.get(eTag[1]!)!;
          if (event.kind === 7) stats.reactionEvents.push(event);
          else if (event.kind === 6 || event.kind === 16) stats.repostEvents.push(event);
          else if (event.kind === 1 || event.kind === 1111) stats.replyEvents.push(event);
          else if (event.kind === 9735) stats.zapEvents.push(event);
        },
        onEose: () => { clearTimeout(timeout); resolve(); }
      });
    });

    for (const [id, stats] of collectors) {
      this.detailedStatsCache.set(id, stats);
      result.set(id, {
        replies: countVisibleReplies(stats.replyEvents),
        reposts: stats.repostEvents.length,
        quotedReposts: stats.quotedEvents.length,
        likes: stats.reactionEvents.length,
        zaps: this.calculateTotalZaps(stats.zapEvents),
        lastUpdated: stats.lastUpdated
      });
    }

    this.systemLogger.info('ReactionsOrch', `📊 Batch stats loaded for ${collectors.size} notes`);
    return result;
  }

  /**
   * Clear cached stats for a note
   */
  public clearCache(noteId: string): void {
    this.detailedStatsCache.delete(noteId);
  }

  /**
   * Clear all cached stats
   */
  public clearAllCache(): void {
    this.detailedStatsCache.clear();
  }

  /**
   * Validate note ID format
   * Returns true for valid 64-char hex strings, naddr identifiers, or addressable identifiers
   * Returns false for synthetic IDs (e.g., "mutual-mutual_unfollow-...")
   */
  private isValidNoteId(noteId: string): boolean {
    if (!noteId) return false;

    // Valid 64-char hex string (event ID)
    if (/^[a-f0-9]{64}$/i.test(noteId)) return true;

    // Valid naddr (long-form article identifier, bech32 encoded)
    if (noteId.startsWith('naddr1')) return true;

    // Valid addressable identifier (kind:pubkey:d-tag format for long-form articles)
    // isLongFormArticle checks for colon presence
    return this.isLongFormArticle(noteId);
  }

  /**
   * Start live reactions polling for ISL
   * @param noteId - Note ID to watch for new reactions
   * @param callback - Called when reaction stats update
   * @param options - Polling configuration
   */
  public startLiveReactions(
    noteId: string,
    callback: (stats: InteractionStats) => void,
    options: LiveReactionsOptions = {}
  ): void {
    const interval = options.interval || 30000; // Default: 30s

    // Check if already polling
    if (this.reactionIntervals.has(noteId)) {
      this.systemLogger.warn('ReactionsOrchestrator', `Already polling reactions for ${noteId}`);
      return;
    }

    // Initialize timestamp
    this.lastReactionFetch.set(noteId, Math.floor(Date.now() / 1000));

    this.systemLogger.info(
      'ReactionsOrchestrator',
      `Live reactions started for ${noteId} (${interval}ms interval)`
    );

    // Start polling
    const intervalId = window.setInterval(async () => {
      await this.pollReactions(noteId, callback);
    }, interval);

    this.reactionIntervals.set(noteId, intervalId);
  }

  /**
   * Poll for new reactions since last fetch
   * NORMAL NOTES: Poll #e tag only (unchanged)
   * LONG-FORM ARTICLES: Poll both #a and #e tags
   */
  private async pollReactions(noteId: string, callback: (stats: InteractionStats) => void): Promise<void> {
    const lastFetch = this.lastReactionFetch.get(noteId);
    if (!lastFetch) {
      this.systemLogger.warn('ReactionsOrchestrator', `No last fetch timestamp for ${noteId}`);
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const relays = await this.getReactionFetchRelays();

    const isArticle = this.isLongFormArticle(noteId);
    const articleEventId = isArticle ? this.articleEventIdCache.get(noteId) : undefined;

    // Build filters based on note type
    const filters: NDKFilter[] = [];

    if (isArticle) {
      // LONG-FORM ARTICLE: Poll both #a and #e
      filters.push({ kinds: [7], '#a': [noteId], since: lastFetch, until: now });
      if (articleEventId) {
        filters.push({ kinds: [7], '#e': [articleEventId], since: lastFetch, until: now });
      }
    } else {
      // NORMAL NOTE: Poll #e only (unchanged)
      filters.push({ kinds: [7], '#e': [noteId], since: lastFetch, until: now });
    }

    try {
      const newReactions = await this.transport.fetch(relays, filters, 5000, false, 'ReactionsOrch');

      if (newReactions.length > 0) {
        this.systemLogger.info(
          'ReactionsOrchestrator',
          `Polled ${newReactions.length} new reactions for ${noteId}`
        );

        // Update cache with new reactions
        const cached = this.detailedStatsCache.get(noteId);
        if (cached) {
          // Deduplicate new reactions by author (one reaction per author)
          const seenAuthors = new Set(cached.reactionEvents.map(e => e.pubkey));
          newReactions.forEach(event => {
            if (!seenAuthors.has(event.pubkey)) {
              cached.reactionEvents.push(event);
              seenAuthors.add(event.pubkey);
            }
          });

          cached.lastUpdated = Date.now();

          // Calculate updated stats and notify callback
          const stats: InteractionStats = {
            replies: countVisibleReplies(cached.replyEvents),
            reposts: cached.repostEvents.length,
            quotedReposts: cached.quotedEvents.length,
            likes: cached.reactionEvents.length,
            zaps: this.calculateTotalZaps(cached.zapEvents),
            lastUpdated: cached.lastUpdated
          };

          callback(stats);
        }
      }

      // Update timestamp
      this.lastReactionFetch.set(noteId, now);
    } catch (error) {
      this.systemLogger.error('ReactionsOrchestrator', `Polling failed: ${error}`);
    }
  }

  /**
   * Stop live reactions polling
   * @param noteId - Note ID to stop watching
   */
  public stopLiveReactions(noteId: string): void {
    const intervalId = this.reactionIntervals.get(noteId);
    if (!intervalId) {
      this.systemLogger.warn('ReactionsOrchestrator', `No polling interval found for ${noteId}`);
      return;
    }

    clearInterval(intervalId);
    this.reactionIntervals.delete(noteId);
    this.lastReactionFetch.delete(noteId);

    this.systemLogger.info('ReactionsOrchestrator', `Live reactions stopped for ${noteId}`);
  }

  // Orchestrator interface implementations (unused for now, required by base class)

  public onui(_data: any): void {
    // Handle UI actions (future: real-time subscriptions)
  }

  public onopen(_relay: string): void {
    // Silent operation
  }

  public onmessage(_relay: string, _event: NostrEvent): void {
    // Handle incoming events from subscriptions (future: live updates)
  }

  public onerror(relay: string, error: Error): void {
    this.systemLogger.error('ReactionsOrchestrator', `Relay error (${relay}): ${error.message}`);
  }

  public onclose(_relay: string): void {
    // Silent operation
  }

  public override destroy(): void {
    // Stop eviction timer
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }

    // Stop all polling intervals before cleanup
    this.reactionIntervals.forEach((intervalId, noteId) => {
      clearInterval(intervalId);
      this.systemLogger.info('ReactionsOrchestrator', `Stopped polling for ${noteId}`);
    });
    this.reactionIntervals.clear();
    this.lastReactionFetch.clear();

    this.detailedStatsCache.clear();
    this.fetchingDetailedStats.clear();
    this.authorPubkeyCache.clear();
    this.articleEventIdCache.clear();
    super.destroy();
    this.systemLogger.info('ReactionsOrchestrator', 'Destroyed');
  }
}
