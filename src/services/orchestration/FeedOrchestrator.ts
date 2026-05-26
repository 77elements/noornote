/**
 * FeedOrchestrator - Timeline Feed Management
 * Handles all timeline feed loading (initial, load more, new notes)
 *
 * @orchestrator FeedOrchestrator
 * @purpose Coordinate timeline feed loading and distribution
 * @used-by TimelineUI
 *
 * Architecture:
 * - Replaces TimelineLoader + LoadMore + parts of EventFetchService
 * - Uses NostrTransport for all relay communication
 * - Caches and deduplicates events
 * - Distributes events to registered components (TimelineUI)
 */

import type { NostrEvent, NDKFilter } from '@nostr-dev-kit/ndk';
import { Orchestrator } from './Orchestrator';
import { NostrTransport } from '../transport/NostrTransport';
import { OutboundRelaysOrchestrator } from './OutboundRelaysOrchestrator';
import { MuteOrchestrator } from '../../lists/mutes';
import { NoteService } from '../NoteService';
import { SystemLogger } from '../SystemLogger';
import { AppState } from '../AppState';
import { AuthService } from '../AuthService';
import { diagLog } from '../DiagnosticLogger';
import { isDataSaverEnabled } from '../DataSaverService';

export interface FeedLoadRequest {
  followingPubkeys: string[];
  includeReplies: boolean;
  timeWindowHours?: number;
  until?: number;
  since?: number; // Optional: Explicit lower bound (Unix timestamp) for time range mode
  specificRelay?: string; // Optional: Only fetch from this relay (for relay-filtered timeline)
  recursionDepth?: number; // Track recursion depth to prevent infinite loops
  exemptFromMuteFilter?: string; // Optional: Pubkey to exempt from mute filtering (for ProfileView)
}

export interface FeedLoadResult {
  events: NostrEvent[];
  hasMore: boolean;
}

export interface NewNotesInfo {
  count: number;
  authorPubkeys: string[]; // Unique pubkeys of new note authors (max 4, newest first)
}

type FeedCallback = (events: NostrEvent[]) => void;
type NewNotesCallback = (info: NewNotesInfo) => void;

export class FeedOrchestrator extends Orchestrator {
  private static instance: FeedOrchestrator;
  private transport: NostrTransport;
  private relayDiscovery: OutboundRelaysOrchestrator;
  private muteOrchestrator: ReturnType<typeof MuteOrchestrator.getInstance>;
  private noteService: NoteService;
  private systemLogger: SystemLogger;
  private mutedPubkeys: Set<string> = new Set();

  /** Registered callbacks for event updates */
  private callbacks: Set<FeedCallback> = new Set();

  /** New notes polling */
  private pollingInterval: number = isDataSaverEnabled() ? 180000 : 60000;
  private readonly fetchLimit = isDataSaverEnabled() ? 20 : 50;
  private readonly pollLimit = isDataSaverEnabled() ? 30 : 100;
  private pollingIntervalId: number | null = null;
  private pollingTimeoutId: number | null = null; // Track setTimeout for cancellation
  private pollingScheduled: boolean = false; // Track if polling is scheduled (before interval starts)
  private lastCheckedTimestamp: number = 0;
  private newNotesCallback: NewNotesCallback | null = null;
  private pollingFollowingPubkeys: string[] = [];
  private pollingIncludeReplies: boolean = false;
  private pollingSpecificRelay: string | null = null; // Poll only from this relay (for relay-filtered timeline)
  private pollingExemptFromMuteFilter: string | undefined = undefined; // Exempt pubkey for ProfileView
  private lastFoundCount: number = 0;
  private polledEventsCache: NostrEvent[] = []; // Cache for new events found during polling
  private isManualPoll: boolean = false; // Track if this is a manual poll (user clicked link)

  private constructor() {
    super('FeedOrchestrator');
    this.transport = NostrTransport.getInstance();
    this.relayDiscovery = OutboundRelaysOrchestrator.getInstance();
    this.muteOrchestrator = MuteOrchestrator.getInstance();
    this.noteService = NoteService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.systemLogger.info('FeedOrchestrator', 'Feed Orchestrator at your service');
    this.loadMutedUsers();
  }

  public static getInstance(): FeedOrchestrator {
    if (!FeedOrchestrator.instance) {
      FeedOrchestrator.instance = new FeedOrchestrator();
    }
    return FeedOrchestrator.instance;
  }

  /**
   * Register callback for feed updates
   */
  public registerCallback(callback: FeedCallback): void {
    this.callbacks.add(callback);
  }

  /**
   * Unregister callback
   */
  public unregisterCallback(callback: FeedCallback): void {
    this.callbacks.delete(callback);
  }

  /**
   * Get a loaded note by event ID (without fetching)
   * Delegates to NoteService
   */
  public getLoadedNote(eventId: string): NostrEvent | null {
    return this.noteService.getCachedNote(eventId);
  }

  /**
   * Check if a note is loaded
   * Delegates to NoteService
   */
  public hasLoadedNote(eventId: string): boolean {
    return this.noteService.hasNote(eventId);
  }

  /**
   * Register notes (for external components to add notes to cache)
   * Delegates to NoteService
   */
  public registerNotes(events: NostrEvent[]): void {
    this.noteService.registerNotes(events);
  }

  /**
   * Load initial timeline feed (Cache-First Pattern)
   */
  public async loadInitialFeed(request: FeedLoadRequest): Promise<FeedLoadResult> {
    const { followingPubkeys, includeReplies, timeWindowHours = 1, specificRelay, exemptFromMuteFilter, since: explicitSince, until: explicitUntil } = request;
    const isProfileView = followingPubkeys.length === 1;
    const isTimeRangeMode = explicitSince !== undefined;

    this.systemLogger.info(
      'FeedOrchestrator',
      isProfileView
        ? `Loading profile for ${followingPubkeys[0]?.slice(0, 8)} (direct fetch, no time window)`
        : isTimeRangeMode
          ? `Loading time range ${new Date(explicitSince * 1000).toLocaleDateString()} – ${new Date((explicitUntil ?? Date.now() / 1000) * 1000).toLocaleDateString()}`
          : `Loading timeline for ${followingPubkeys.length} users (${timeWindowHours}h window)${specificRelay ? ` from ${specificRelay}` : ''}`
    );

    try {
      const relays = await this.getRelaysForRequest(followingPubkeys, specificRelay, isProfileView);

      // ProfileView: Direct fetch with limit only (no time window) - gets newest posts regardless of age
      // Time Range Mode: Use explicit since/until boundaries
      // TimelineView: Time-windowed fetch (default 1h)
      let filters: NDKFilter<number>[];
      if (isProfileView) {
        filters = [{
          authors: followingPubkeys,
          kinds: [1, 6, 16, 20, 21, 22, 1063, 1068, 1617, 1618, 1619, 1621, 1630, 1631, 1632, 1633, 9802, 30617, 39089],
          limit: this.fetchLimit
        }];
      } else if (isTimeRangeMode) {
        const filterObj: NDKFilter<number> = {
          authors: followingPubkeys,
          kinds: [1, 6, 16, 20, 21, 22, 1063, 1068, 1617, 1618, 1619, 1621, 1630, 1631, 1632, 1633, 9802, 30617, 39089],
          limit: this.fetchLimit,
          since: explicitSince
        };
        if (explicitUntil !== undefined) {
          filterObj.until = explicitUntil;
        }
        filters = [filterObj];
      } else {
        filters = [{
          authors: followingPubkeys,
          kinds: [1, 6, 16, 20, 21, 22, 1063, 1068, 1617, 1618, 1619, 1621, 1630, 1631, 1632, 1633, 9802, 30617, 39089],
          limit: this.fetchLimit,
          since: Math.floor(Date.now() / 1000) - (timeWindowHours * 3600)
        }];
      }

      const events = await this.fetchEvents(relays, filters, isProfileView, !!specificRelay);
      const filteredEvents = await this.processEvents(events, includeReplies, exemptFromMuteFilter);

      this.systemLogger.info(
        'FeedOrchestrator',
        `Loaded ${filteredEvents.length} notes from relays`
      );

      // Skip auto-expand in time range mode (user selected explicit boundaries)
      if (isTimeRangeMode) {
        const resultEvents = filteredEvents.slice(0, this.fetchLimit);
        this.registerNotes(resultEvents);
        return {
          events: resultEvents,
          hasMore: true
        };
      }

      // Auto-load more if needed (Timeline only - Profile gets all via direct fetch)
      const minimumNotes = 10;
      if (!isProfileView && filteredEvents.length < minimumNotes) {
        const maxAttempts = 16; // Timeline: 16 attempts (48h)
        const now = Math.floor(Date.now() / 1000);

        this.systemLogger.info(
          'FeedOrchestrator',
          `⚠️ ${filteredEvents.length} events found in ${timeWindowHours}h window - Auto-loading more (minimum ${minimumNotes} needed)`
        );

        let accumulatedEvents = [...filteredEvents];
        let currentUntil = now;
        let attempt = 0;
        const nostrEpoch = Math.floor(new Date('2020-01-01').getTime() / 1000);

        while (accumulatedEvents.length < minimumNotes && attempt < maxAttempts) {
          attempt++;

          if (currentUntil < nostrEpoch) {
            this.systemLogger.info('FeedOrchestrator', '📭 No events found in past 48 hours');
            break;
          }

          const loadMoreRequest: FeedLoadRequest & { until: number } = {
            followingPubkeys,
            includeReplies,
            until: currentUntil,
            timeWindowHours: 3 // Load More uses 3h chunks
          };
          if (specificRelay !== undefined) {
            loadMoreRequest.specificRelay = specificRelay;
          }
          const loadMoreResult = await this.loadMore(loadMoreRequest);

          // Merge new events and deduplicate by event ID
          const mergedEvents = [...accumulatedEvents, ...loadMoreResult.events];
          accumulatedEvents = Array.from(
            new Map(mergedEvents.map(e => [e.id, e])).values()
          );
          // Re-sort after deduplication (newest first)
          accumulatedEvents.sort((a, b) => b.created_at - a.created_at);
          currentUntil = loadMoreResult.events[loadMoreResult.events.length - 1]?.created_at || currentUntil - 3 * 3600;

          if (accumulatedEvents.length >= minimumNotes) {
            const hoursSearched = Math.round((now - currentUntil) / 3600);
            this.systemLogger.info(
              'FeedOrchestrator',
              `✅ Auto-load found ${accumulatedEvents.length} events (searched back ${hoursSearched}h)`
            );
            break;
          }
        }

        const resultEvents = accumulatedEvents.slice(0, this.fetchLimit);
        this.registerNotes(resultEvents);
        return {
          events: resultEvents,
          hasMore: accumulatedEvents.length > 0
        };
      }

      const resultEvents = filteredEvents.slice(0, this.fetchLimit);
      this.registerNotes(resultEvents);
      return {
        events: resultEvents,
        hasMore: true
      };
    } catch (error) {
      this.systemLogger.error('FeedOrchestrator', `Initial load failed: ${error}`);
      return {
        events: [],
        hasMore: false
      };
    }
  }

  /**
   * Load more events (infinite scroll) - Cache-First Pattern
   */
  public async loadMore(request: FeedLoadRequest & { until: number }): Promise<FeedLoadResult> {
    const { followingPubkeys, includeReplies, until, timeWindowHours = 3, specificRelay, recursionDepth = 0, exemptFromMuteFilter, since: explicitSince } = request;
    const isProfileView = followingPubkeys.length === 1;
    const isTimeRangeMode = explicitSince !== undefined;

    this.systemLogger.info(
      'FeedOrchestrator',
      `Loading more events before ${new Date(until * 1000).toISOString()}${specificRelay ? ` from ${specificRelay}` : ''}`
    );

    try {
      const timeWindowSeconds = timeWindowHours * 3600;
      let since = until - timeWindowSeconds;

      // In time range mode, clamp since to the explicit lower bound
      if (isTimeRangeMode && since < explicitSince) {
        since = explicitSince;
      }

      // If we've already reached the lower bound, no more to load
      if (isTimeRangeMode && until <= explicitSince) {
        return { events: [], hasMore: false };
      }

      const relays = await this.getRelaysForRequest(followingPubkeys, specificRelay, isProfileView);

      const filters: NDKFilter<number>[] = [{
        authors: followingPubkeys,
        kinds: [1, 6, 16, 20, 21, 22, 1063, 1068, 1617, 1618, 1619, 1621, 1630, 1631, 1632, 1633, 9802, 30617, 39089],
        until: until - 1,
        since,
        limit: 50
      }];

      const events = await this.fetchEvents(relays, filters, isProfileView, !!specificRelay);
      const filteredEvents = await this.processEvents(events, includeReplies, exemptFromMuteFilter);

      this.systemLogger.info(
        'FeedOrchestrator',
        `Loaded ${filteredEvents.length} more events from relays`
      );

      // Auto-load more if this chunk returned 0 events (gap in posting history)
      // Disabled in time range mode — don't search beyond the user's selected range
      // Timeline View: up to 7 days back from current 'until'
      // Profile View: max 3 recursive attempts to find events
      if (filteredEvents.length === 0 && !isTimeRangeMode) {
        const now = Math.floor(Date.now() / 1000);
        const timeSinceUntil = now - until;
        const hoursSinceUntil = timeSinceUntil / 3600;

        // Max recursion depth: ProfileView 3 attempts, TimelineView check time limit
        const maxRecursionDepth = isProfileView ? 3 : 56; // Profile: 3 attempts (9h), Timeline: 56 attempts (7 days)

        if (recursionDepth >= maxRecursionDepth) {
          this.systemLogger.info(
            'FeedOrchestrator',
            isProfileView
              ? `📭 No events found after ${recursionDepth} attempts (${Math.round(hoursSinceUntil)}h searched)`
              : '📭 Reached 7-day limit - no more events'
          );
          return {
            events: [],
            hasMore: false
          };
        }

        // Timeline View: also check time limit (7 days)
        if (!isProfileView && hoursSinceUntil >= 168) {
          this.systemLogger.info(
            'FeedOrchestrator',
            '📭 Reached 7-day limit - no more events'
          );
          return {
            events: [],
            hasMore: false
          };
        }

        this.systemLogger.info(
          'FeedOrchestrator',
          `⚠️ 0 events in this chunk - Auto-loading next chunk (attempt ${recursionDepth + 1}/${maxRecursionDepth}, ${Math.round(hoursSinceUntil)}h searched)`
        );

        // Recursively load the next chunk
        const recursiveRequest: FeedLoadRequest & { until: number } = {
          followingPubkeys,
          includeReplies,
          until: until - timeWindowSeconds,
          timeWindowHours,
          recursionDepth: recursionDepth + 1
        };
        if (specificRelay !== undefined) {
          recursiveRequest.specificRelay = specificRelay;
        }
        return await this.loadMore(recursiveRequest);
      }

      const resultEvents = filteredEvents.slice(0, this.fetchLimit);
      this.registerNotes(resultEvents);

      // In time range mode, check if we've reached the lower boundary
      const hasMore = isTimeRangeMode
        ? since > explicitSince
        : true; // Always more history on Nostr

      return {
        events: resultEvents,
        hasMore
      };
    } catch (error) {
      this.systemLogger.error('FeedOrchestrator', `Load more failed: ${error}`);
      return {
        events: [],
        hasMore: false
      };
    }
  }

  /**
   * Get relay URLs for an event
   */
  public getEventRelays(_eventId: string): string[] {
    return [];
  }


  /**
   * Filter out replies
   */
  private filterReplies(events: NostrEvent[]): NostrEvent[] {
    return events.filter(event => {
      // Always allow reposts (kind 6), pictures (kind 20), videos (kind 21/22), polls (kind 1068)
      if (event.kind === 6 || event.kind === 16 || event.kind === 20 || event.kind === 1068 || event.kind === 21 || event.kind === 22) return true;

      const content = event.content.trim();

      // Content-based detection: starts with @username or npub
      if (content.match(/^@\w+/) || content.startsWith('npub1')) {
        return false;
      }

      // Tag-based detection: has 'e' tags (reply to event)
      const eTags = event.tags.filter(tag => tag[0] === 'e');
      if (eTags.length > 0) {
        // Legacy quote-repost (Primal-iOS pre-NIP-18): all e-tags carry the
        // NIP-10 "mention" marker AND the content embeds a nostr: reference.
        const allMention = eTags.every(t => t[3] === 'mention');
        const hasNostrRef = /nostr:(nevent1|note1|naddr1)/.test(event.content);
        if (allMention && hasNostrRef) return true;
        return false;
      }

      return true;
    });
  }

  /**
   * Process events: deduplicate, filter replies/muted users, sort by timestamp
   * Consolidates the common event processing pattern used across loadInitialFeed, loadMore, and poll
   */
  private async processEvents(
    events: NostrEvent[],
    includeReplies: boolean,
    exemptFromMuteFilter?: string
  ): Promise<NostrEvent[]> {
    // Deduplicate events by ID
    const uniqueEvents = Array.from(
      new Map(events.map(e => [e.id, e])).values()
    );

    // Filter replies if needed
    let filteredEvents = includeReplies ? uniqueEvents : this.filterReplies(uniqueEvents);

    // Filter muted users
    filteredEvents = await this.filterMutedUsers(filteredEvents, exemptFromMuteFilter);

    // Filter content words (skip for ProfileView — exemptFromMuteFilter means PV)
    if (!exemptFromMuteFilter) {
      const { isContentWordFilterEnabled, filterContentWords, getFilterWords } = await import('../../addons/content-word-filter/index');
      if (isContentWordFilterEnabled()) {
        const before = filteredEvents.length;
        filteredEvents = filterContentWords(filteredEvents);
        const removed = before - filteredEvents.length;
        if (removed > 0) {
          diagLog('system', `Word filter: removed ${removed} notes from timeline`, { words: getFilterWords() });
        }
      }
    }

    // Sort by timestamp (newest first)
    filteredEvents.sort((a, b) => b.created_at - a.created_at);

    return filteredEvents;
  }

  /**
   * Get relays for fetching based on request parameters
   */
  private async getRelaysForRequest(
    followingPubkeys: string[],
    specificRelay?: string,
    isProfileView: boolean = false
  ): Promise<string[]> {
    if (specificRelay) {
      return [specificRelay];
    }
    return await this.relayDiscovery.getCombinedRelays(followingPubkeys, isProfileView);
  }

  /**
   * Fetch events using appropriate method (subscription for ProfileView, fetch for Timeline)
   */
  private async fetchEvents(
    relays: string[],
    filters: NDKFilter<number>[],
    isProfileView: boolean,
    skipCache: boolean
  ): Promise<NostrEvent[]> {
    return await this.transport.fetch(relays, filters, isProfileView ? 15000 : 5000, skipCache, 'FeedOrch');
  }

  /**
   * Clear cache (for refresh)
   * Note: Only clears NoteService cache, not other caches
   */
  public clearCache(): void {
    this.noteService.clearCache();
    this.systemLogger.info('FeedOrchestrator', 'Feed cache cleared');
  }

  // Orchestrator interface implementations (unused for now, but required by base class)

  public onui(_data: any): void {
    // Handle UI actions (future: real-time subscriptions)
  }

  public onopen(relay: string): void {
    this.systemLogger.info('FeedOrchestrator', `Relay opened: ${relay}`);
  }

  public onmessage(_relay: string, event: NostrEvent): void {
    // Handle incoming events from subscriptions - notify callbacks
    this.callbacks.forEach(callback => callback([event]));
  }

  public onerror(relay: string, error: Error): void {
    this.systemLogger.error('FeedOrchestrator', `Relay error (${relay}): ${error.message}`);
  }

  public onclose(relay: string): void {
    this.systemLogger.info('FeedOrchestrator', `Relay closed: ${relay}`);
  }

  /**
   * Start polling for new notes
   * @param followingPubkeys - List of pubkeys to check for new notes
   * @param lastLoadedTimestamp - Timestamp of the most recent note in timeline
   * @param callback - Function to call when new notes are detected
   * @param includeReplies - Whether to include reply notes
   * @param delayMs - Delay before starting polling (default: 10000ms)
   * @param specificRelay - Optional: Only poll from this relay (for relay-filtered timeline)
   */
  public startPolling(
    followingPubkeys: string[],
    lastLoadedTimestamp: number,
    callback: NewNotesCallback,
    includeReplies: boolean = false,
    delayMs: number = 10000,
    specificRelay: string | null = null,
    exemptFromMuteFilter?: string
  ): void {
    // Stop any existing polling
    this.stopPolling();

    this.pollingFollowingPubkeys = followingPubkeys;
    this.lastCheckedTimestamp = lastLoadedTimestamp;
    this.newNotesCallback = callback;
    this.pollingIncludeReplies = includeReplies;
    this.pollingSpecificRelay = specificRelay;
    this.pollingExemptFromMuteFilter = exemptFromMuteFilter;
    this.pollingScheduled = true; // Mark as scheduled immediately

    // Track manual poll (user clicked link) vs automatic poll
    this.isManualPoll = delayMs === 0;

    // Log message only for scheduled polls (not manual)
    if (!this.isManualPoll) {
      this.systemLogger.info(
        'FeedOrchestrator',
        `Starting to look for new notes in ${delayMs / 1000}s${specificRelay ? ` from ${specificRelay}` : ''}`
      );
    }

    // Start polling after delay (store timeout ID for cancellation)
    this.pollingTimeoutId = window.setTimeout(() => {
      this.pollingTimeoutId = null; // Clear reference after firing
      this.poll(); // First poll immediately after delay
      this.pollingIntervalId = window.setInterval(() => this.poll(), this.pollingInterval);
    }, delayMs);
  }

  /**
   * Check if polling is currently active or scheduled
   */
  public isPolling(): boolean {
    return this.pollingScheduled || this.pollingTimeoutId !== null || this.pollingIntervalId !== null;
  }

  /**
   * Stop polling for new notes
   */
  public stopPolling(): void {
    // Clear pending timeout (before interval starts)
    if (this.pollingTimeoutId !== null) {
      clearTimeout(this.pollingTimeoutId);
      this.pollingTimeoutId = null;
    }
    // Clear running interval
    if (this.pollingIntervalId !== null) {
      clearInterval(this.pollingIntervalId);
      this.pollingIntervalId = null;
    }
    this.pollingScheduled = false;
  }

  /**
   * Reset last checked timestamp (call this when timeline is refreshed)
   */
  public resetPollingTimestamp(newTimestamp: number): void {
    this.lastCheckedTimestamp = newTimestamp;
    this.lastFoundCount = 0;
    this.systemLogger.info(
      'FeedOrchestrator',
      `Polling timestamp reset to ${new Date(newTimestamp * 1000).toISOString()}`
    );
  }

  /**
   * Get cached polled events and clear cache
   */
  public getPolledEvents(): NostrEvent[] {
    const events = [...this.polledEventsCache];
    this.polledEventsCache = [];
    this.lastFoundCount = 0;
    return events;
  }

  /**
   * Poll relays for new notes
   */
  private async poll(): Promise<void> {
    if (!this.newNotesCallback || this.pollingFollowingPubkeys.length === 0) {
      return;
    }

    try {
      // Use specific relay if set (relay-filtered timeline), otherwise all read relays
      const relays = this.pollingSpecificRelay
        ? [this.pollingSpecificRelay]
        : this.transport.getReadRelays();

      if (relays.length === 0) {
        this.systemLogger.warn('FeedOrchestrator', 'No read relays configured for polling');
        return;
      }

      const now = Math.floor(Date.now() / 1000);

      // Query for new notes since last check
      const filters = [{
        kinds: [1, 6, 16, 20, 21, 22, 1063, 1068, 1617, 1618, 1619, 1621, 1630, 1631, 1632, 1633, 9802, 30617, 39089], // Text notes + reposts + polls (NIP-88)
        authors: this.pollingFollowingPubkeys,
        since: this.lastCheckedTimestamp + 1,
        until: now,
        limit: this.pollLimit
      }];

      const events = await this.transport.fetch(relays, filters, 5000, true, 'FeedOrch'); // Skip cache for polling
      const filteredEvents = await this.processEvents(events, this.pollingIncludeReplies, this.pollingExemptFromMuteFilter);

      if (filteredEvents.length > 0) {
        // Cache polled events for later retrieval (already sorted by processEvents)
        this.polledEventsCache = filteredEvents;

        // Only log when count changes - compact format
        // Only log if currently in Timeline view (not SNV, Profile, etc.)
        if (filteredEvents.length !== this.lastFoundCount) {
          const appState = AppState.getInstance();
          const currentView = appState.getState('view').currentView;

          if (currentView === 'timeline') {
            this.systemLogger.info(
              'FeedOrchestrator',
              `🔔 ${filteredEvents.length} new note${filteredEvents.length !== 1 ? 's' : ''} available`
            );
          }
          this.lastFoundCount = filteredEvents.length;
        }

        // Extract unique author pubkeys (newest first, max 4)
        const uniqueAuthors: string[] = [];
        const seen = new Set<string>();

        for (const event of filteredEvents) {
          if (!seen.has(event.pubkey)) {
            uniqueAuthors.push(event.pubkey);
            seen.add(event.pubkey);
            if (uniqueAuthors.length >= 4) break;
          }
        }

        const info: NewNotesInfo = {
          count: filteredEvents.length,
          authorPubkeys: uniqueAuthors
        };

        // Notify callback
        this.newNotesCallback(info);
      } else {
        this.lastFoundCount = 0;
        this.polledEventsCache = [];
      }

      // Log manual poll result
      if (this.isManualPoll) {
        const relayInfo = this.pollingSpecificRelay ? ` from ${this.pollingSpecificRelay}` : '';
        const message = filteredEvents.length > 0
          ? `Looked for new notes. Found ${filteredEvents.length} new note${filteredEvents.length !== 1 ? 's' : ''}. Will look again in ${this.pollingInterval / 1000}s${relayInfo}`
          : `Looked for new notes. Found no new notes. Will look again in ${this.pollingInterval / 1000}s${relayInfo}`;
        this.systemLogger.info('FeedOrchestrator', message);
        this.isManualPoll = false; // Reset flag
      }

    } catch (error) {
      this.systemLogger.error('FeedOrchestrator', `Polling error: ${error}`);

      // Log manual poll error
      if (this.isManualPoll) {
        this.systemLogger.info('FeedOrchestrator', `Looked for new notes. Error occurred. Will look again in ${this.pollingInterval / 1000}s`);
        this.isManualPoll = false; // Reset flag
      }
    }
  }

  /**
   * Load muted users from MuteOrchestrator
   */
  private async loadMutedUsers(): Promise<void> {
    try {
      const currentUser = AuthService.getInstance().getCurrentUser();
      if (!currentUser) return;

      const mutedPubkeys = await this.muteOrchestrator.getAllMutedUsers(currentUser.pubkey);
      this.mutedPubkeys = new Set(mutedPubkeys);

      if (mutedPubkeys.length > 0) {
        this.systemLogger.info('FeedOrchestrator', `Loaded ${mutedPubkeys.length} muted users`);
      }
    } catch (error) {
      this.systemLogger.error('FeedOrchestrator', `Failed to load muted users: ${error}`);
    }
  }

  /**
   * Check if a pubkey is temporarily unmuted
   */
  private isTemporarilyUnmuted(pubkey: string, muteOrch: ReturnType<typeof MuteOrchestrator.getInstance>): boolean {
    const currentUser = AuthService.getInstance().getCurrentUser();
    if (!currentUser) return false;
    return (muteOrch as any).temporaryUnmutes?.has(pubkey) ?? false;
  }

  /**
   * Filter out events from muted users
   * Also filters reposts (Kind 6) where the reposted author is muted
   * Respects temporary unmutes
   * @param exemptPubkey - Optional pubkey to exempt from filtering (for ProfileView)
   */
  private async filterMutedUsers(events: NostrEvent[], exemptPubkey?: string): Promise<NostrEvent[]> {
    if (this.mutedPubkeys.size === 0) {
      return events;
    }

    const muteOrch = MuteOrchestrator.getInstance();

    return events.filter(event => {
      // NEVER filter exempt pubkey (ProfileView scenario)
      if (exemptPubkey && event.pubkey === exemptPubkey) {
        return true;
      }

      // Filter direct posts from muted users (unless temporarily unmuted)
      if (this.mutedPubkeys.has(event.pubkey)) {
        return this.isTemporarilyUnmuted(event.pubkey, muteOrch);
      }

      // Filter reposts (Kind 6/16) where the original author is muted
      if (event.kind === 6 || event.kind === 16) {
        const repostedAuthorTag = event.tags.find(tag => tag[0] === 'p');
        const repostedAuthorPubkey = repostedAuthorTag?.[1];
        if (repostedAuthorPubkey && this.mutedPubkeys.has(repostedAuthorPubkey)) {
          return this.isTemporarilyUnmuted(repostedAuthorPubkey, muteOrch);
        }
      }

      return true;
    });
  }

  /**
   * One-shot poll for new notes (used by pull-to-refresh)
   * Returns filtered events directly without affecting polling state
   */
  public async pollOnce(
    followingPubkeys: string[],
    newestTimestamp: number,
    includeReplies: boolean,
    specificRelay: string | null,
    exemptFromMuteFilter?: string
  ): Promise<NostrEvent[]> {
    try {
      const relays = specificRelay
        ? [specificRelay]
        : this.transport.getReadRelays();

      if (relays.length === 0) return [];

      const now = Math.floor(Date.now() / 1000);
      const filters = [{
        kinds: [1, 6, 16, 20, 21, 22, 1063, 1068, 1617, 1618, 1619, 1621, 1630, 1631, 1632, 1633, 9802, 30617, 39089],
        authors: followingPubkeys,
        since: newestTimestamp + 1,
        until: now,
        limit: this.pollLimit
      }];

      const events = await this.transport.fetch(relays, filters, 5000, true, 'FeedOrch');
      return await this.processEvents(events, includeReplies, exemptFromMuteFilter);
    } catch (error) {
      this.systemLogger.error('FeedOrchestrator', `pollOnce failed: ${error}`);
      return [];
    }
  }

  /**
   * Refresh muted users list (called when mute list is updated)
   */
  public async refreshMutedUsers(): Promise<void> {
    await this.loadMutedUsers();
  }

  public override destroy(): void {
    this.stopPolling();
    this.callbacks.clear();
    super.destroy();
    this.systemLogger.info('FeedOrchestrator', 'Destroyed');
  }
}
