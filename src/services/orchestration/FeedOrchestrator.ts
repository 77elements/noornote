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
import { MuteOrchestrator } from './MuteOrchestrator';
import { SystemLogger } from '../../components/system/SystemLogger';
import { AppState } from '../AppState';
import { AuthService } from '../AuthService';

export interface FeedLoadRequest {
  followingPubkeys: string[];
  includeReplies: boolean;
  timeWindowHours?: number;
  until?: number;
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
  private muteOrchestrator: MuteOrchestrator;
  private systemLogger: SystemLogger;
  private mutedPubkeys: Set<string> = new Set();

  /** Registered callbacks for event updates */
  private callbacks: Set<FeedCallback> = new Set();

  /** New notes polling */
  private pollingInterval: number = 60000; // 60 seconds
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

  private constructor() {
    super('FeedOrchestrator');
    this.transport = NostrTransport.getInstance();
    this.relayDiscovery = OutboundRelaysOrchestrator.getInstance();
    this.muteOrchestrator = MuteOrchestrator.getInstance();
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
   * Load initial timeline feed (Cache-First Pattern)
   */
  public async loadInitialFeed(request: FeedLoadRequest): Promise<FeedLoadResult> {
    const { followingPubkeys, includeReplies, timeWindowHours = 1, specificRelay, exemptFromMuteFilter } = request;
    const isProfileView = followingPubkeys.length === 1;

    this.systemLogger.info(
      'FeedOrchestrator',
      isProfileView
        ? `Loading profile for ${followingPubkeys[0]?.slice(0, 8)} (direct fetch, no time window)`
        : `Loading timeline for ${followingPubkeys.length} users (${timeWindowHours}h window)${specificRelay ? ` from ${specificRelay}` : ''}`
    );

    try {
      // Determine relays to fetch from
      // ProfileView (single author): Use author's NIP-65 relays for better content discovery
      // TimelineView (multiple authors): Use standard relays only (performance)
      const relays = specificRelay
        ? [specificRelay]
        : await this.relayDiscovery.getCombinedRelays(followingPubkeys, isProfileView);

      // ProfileView: Direct fetch with limit only (no time window) - gets newest posts regardless of age
      // TimelineView: Time-windowed fetch (default 1h)
      const filters: NDKFilter[] = isProfileView
        ? [{
            authors: followingPubkeys,
            kinds: [1, 6, 1068],
            limit: 50 // Get latest 50 posts, no matter how old
          }]
        : [{
            authors: followingPubkeys,
            kinds: [1, 6, 1068],
            limit: 50,
            since: Math.floor(Date.now() / 1000) - (timeWindowHours * 3600)
          }];

      // ProfileView: Use subscription (persistent connection) instead of one-time fetch
      // Timeline: Use fetch (faster for multiple authors)
      // Skip cache when filtering by specific relay (to get only events from that relay)
      const events = isProfileView
        ? await this.fetchViaSubscription(relays, filters)
        : await this.transport.fetch(relays, filters, 5000, !!specificRelay);

      // Deduplicate events
      const uniqueEvents = Array.from(
        new Map(events.map(e => [e.id, e])).values()
      );

      // Filter replies and muted users
      let filteredEvents = includeReplies ? uniqueEvents : this.filterReplies(uniqueEvents);
      filteredEvents = await this.filterMutedUsers(filteredEvents, exemptFromMuteFilter);

      // Sort by timestamp (newest first)
      filteredEvents.sort((a, b) => b.created_at - a.created_at);

      this.systemLogger.info(
        'FeedOrchestrator',
        `Loaded ${filteredEvents.length} notes from relays`
      );

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

          const loadMoreResult = await this.loadMore({
            followingPubkeys,
            includeReplies,
            until: currentUntil,
            timeWindowHours: 3, // Load More uses 3h chunks
            specificRelay
          });

          accumulatedEvents = [...accumulatedEvents, ...loadMoreResult.events];
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

        return {
          events: accumulatedEvents.slice(0, 50),
          hasMore: accumulatedEvents.length > 0
        };
      }

      return {
        events: filteredEvents.slice(0, 50), // Limit to 50
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
    const { followingPubkeys, includeReplies, until, timeWindowHours = 3, specificRelay, recursionDepth = 0, exemptFromMuteFilter } = request;

    this.systemLogger.info(
      'FeedOrchestrator',
      `Loading more events before ${new Date(until * 1000).toISOString()}${specificRelay ? ` from ${specificRelay}` : ''}`
    );

    try {
      // Build time window
      const timeWindowSeconds = timeWindowHours * 3600;
      const since = until - timeWindowSeconds;

      // Determine relays to fetch from
      // ProfileView (single author): Use author's NIP-65 relays for better content discovery
      // TimelineView (multiple authors): Use standard relays only (performance)
      const isProfileView = followingPubkeys.length === 1;
      const relays = specificRelay
        ? [specificRelay]
        : await this.relayDiscovery.getCombinedRelays(followingPubkeys, isProfileView);

      const filters: NDKFilter[] = [{
        authors: followingPubkeys,
        kinds: [1, 6, 1068],
        until: until - 1,
        since,
        limit: 50
      }];

      // ProfileView: Use subscription, Timeline: Use fetch
      // Skip cache when filtering by specific relay (to get only events from that relay)
      const events = isProfileView
        ? await this.fetchViaSubscription(relays, filters)
        : await this.transport.fetch(relays, filters, 5000, !!specificRelay);

      // Deduplicate events
      const uniqueEvents = Array.from(
        new Map(events.map(e => [e.id, e])).values()
      );

      // Filter replies and muted users
      let filteredEvents = includeReplies ? uniqueEvents : this.filterReplies(uniqueEvents);
      filteredEvents = await this.filterMutedUsers(filteredEvents, exemptFromMuteFilter);

      // Sort by timestamp
      filteredEvents.sort((a, b) => b.created_at - a.created_at);

      this.systemLogger.info(
        'FeedOrchestrator',
        `Loaded ${filteredEvents.length} more events from relays`
      );

      // Auto-load more if this chunk returned 0 events (gap in posting history)
      // Timeline View: up to 7 days back from current 'until'
      // Profile View: max 3 recursive attempts to find events
      if (filteredEvents.length === 0) {
        const isProfileView = followingPubkeys.length === 1; // ProfileView = single author
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
        return await this.loadMore({
          followingPubkeys,
          includeReplies,
          until: until - timeWindowSeconds,
          timeWindowHours,
          specificRelay,
          recursionDepth: recursionDepth + 1
        });
      }

      return {
        events: filteredEvents.slice(0, 50),
        hasMore: true // Always more history on Nostr
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
   * Fetch events via subscription (used for ProfileView)
   * Waits for EOSE from majority of relays before returning
   */
  private async fetchViaSubscription(relays: string[], filters: NDKFilter[]): Promise<NostrEvent[]> {
    return new Promise(async (resolve) => {
      const events: NostrEvent[] = [];
      const eventIds = new Set<string>();
      const relayEoseCount = new Map<string, boolean>();
      const requiredEose = Math.max(1, Math.floor(relays.length / 2)); // Wait for at least half of relays
      const timeout = 10000; // 10 second timeout

      let resolved = false;
      const resolveOnce = () => {
        if (resolved) return;
        resolved = true;
        sub.close();
        this.systemLogger.info(
          'FeedOrchestrator',
          `Subscription: Received ${events.length} events from ${relayEoseCount.size}/${relays.length} relays`
        );
        resolve(events);
      };

      // Subscribe with callbacks
      const sub = await this.transport.subscribe(relays, filters, {
        onEvent: (event: NostrEvent, _relay: string) => {
          // Deduplicate events
          if (!eventIds.has(event.id)) {
            eventIds.add(event.id);
            events.push(event);
          }
        },
        onEose: () => {
          // Track EOSE from relays (we don't know which relay sent EOSE in current implementation)
          // So we just count total EOSE signals
          const eoseCount = relayEoseCount.size + 1;
          relayEoseCount.set(`eose-${eoseCount}`, true);

          // Resolve when we have EOSE from majority of relays
          if (relayEoseCount.size >= requiredEose) {
            resolveOnce();
          }
        }
      });

      // Timeout fallback
      setTimeout(() => {
        if (!resolved) {
          resolveOnce();
        }
      }, timeout);
    });
  }

  /**
   * Filter out replies
   */
  private filterReplies(events: NostrEvent[]): NostrEvent[] {
    return events.filter(event => {
      // Always allow reposts (kind 6) and polls (kind 1068)
      if (event.kind === 6 || event.kind === 1068) return true;

      const content = event.content.trim();

      // Content-based detection: starts with @username or npub
      if (content.match(/^@\w+/) || content.startsWith('npub1')) {
        return false;
      }

      // Tag-based detection: has 'e' tags (reply to event)
      const eTags = event.tags.filter(tag => tag[0] === 'e');
      if (eTags.length > 0) {
        return false;
      }

      return true;
    });
  }

  /**
   * Clear cache (for refresh)
   */
  public clearCache(): void {
    this.systemLogger.info('FeedOrchestrator', 'Feed cache cleared (via EventCacheOrchestrator)');
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

    this.systemLogger.info(
      'FeedOrchestrator',
      `Starting to look for new notes in ${delayMs / 1000}s${specificRelay ? ` from ${specificRelay}` : ''}`
    );

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
        kinds: [1, 6, 1068], // Text notes + reposts + polls (NIP-88)
        authors: this.pollingFollowingPubkeys,
        since: this.lastCheckedTimestamp + 1,
        until: now,
        limit: 100
      }];

      const events = await this.transport.fetch(relays, filters);

      // Cache polled events

      // Filter replies and muted users
      let filteredEvents = this.pollingIncludeReplies ? events : this.filterReplies(events);
      filteredEvents = await this.filterMutedUsers(filteredEvents, this.pollingExemptFromMuteFilter);

      if (filteredEvents.length > 0) {
        // Cache polled events for later retrieval
        this.polledEventsCache = filteredEvents.sort((a, b) => b.created_at - a.created_at);

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

    } catch (error) {
      this.systemLogger.error('FeedOrchestrator', `Polling error: ${error}`);
    }
  }

  /**
   * Load muted users from MuteOrchestrator
   */
  private async loadMutedUsers(): Promise<void> {
    try {
      const authService = await import('../AuthService').then(m => m.AuthService);
      const currentUser = authService.getInstance().getCurrentUser();

      if (!currentUser) {
        return;
      }

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
   * Filter out events from muted users
   * Also filters reposts (Kind 6) where the reposted author is muted
   * Respects temporary unmutes
   * @param exemptPubkey - Optional pubkey to exempt from filtering (for ProfileView)
   */
  private async filterMutedUsers(events: NostrEvent[], exemptPubkey?: string): Promise<NostrEvent[]> {
    if (this.mutedPubkeys.size === 0) {
      return events;
    }

    // Import MuteOrchestrator dynamically to check temporary unmutes
    const { MuteOrchestrator } = await import('./MuteOrchestrator');
    const muteOrch = MuteOrchestrator.getInstance();

    return events.filter(event => {
      // NEVER filter exempt pubkey (ProfileView scenario)
      if (exemptPubkey && event.pubkey === exemptPubkey) {
        return true;
      }

      // Filter direct posts from muted users (unless temporarily unmuted)
      if (this.mutedPubkeys.has(event.pubkey)) {
        // Check if temporarily unmuted
        const authService = this.authService || AuthService.getInstance();
        const currentUser = authService.getCurrentUser();
        if (currentUser) {
          // Use synchronous check via internal Set
          const isTempUnmuted = (muteOrch as any).temporaryUnmutes?.has(event.pubkey);
          if (isTempUnmuted) {
            return true; // Allow event from temporarily unmuted user
          }
        }
        return false;
      }

      // Filter reposts (Kind 6) where the original author is muted
      if (event.kind === 6) {
        // Find 'p' tag (original author)
        const repostedAuthorTag = event.tags.find(tag => tag[0] === 'p');
        if (repostedAuthorTag && repostedAuthorTag[1]) {
          const repostedAuthorPubkey = repostedAuthorTag[1];
          if (this.mutedPubkeys.has(repostedAuthorPubkey)) {
            // Check if temporarily unmuted
            const authService = this.authService || AuthService.getInstance();
            const currentUser = authService.getCurrentUser();
            if (currentUser) {
              const isTempUnmuted = (muteOrch as any).temporaryUnmutes?.has(repostedAuthorPubkey);
              if (isTempUnmuted) {
                return true; // Allow repost from temporarily unmuted user
              }
            }
            return false;
          }
        }
      }

      return true;
    });
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
