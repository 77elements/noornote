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
import { webDiag } from '../WebDiag';
import { isDataSaverEnabled } from '../DataSaverService';
import { isHideSelfRepostsEnabled, getSelfRepostGapSeconds } from '../../helpers/selfRepostSetting';
import type { TimelineConfig } from '../../components/timeline/TimelineConfig';

/**
 * Event kinds requested by the home/tribe feed. Single source of truth; this
 * was previously duplicated verbatim across 7 filter sites in this file.
 */
const FEED_KINDS: number[] = [1, 6, 16, 20, 21, 22, 1063, 1068, 1617, 1618, 1619, 1621, 1630, 1631, 1632, 1633, 9802, 30617, 39089, 30030];

export interface FeedLoadRequest {
  followingPubkeys: string[];
  includeReplies: boolean;
  timeWindowHours?: number;
  until?: number;
  since?: number; // Optional: Explicit lower bound (Unix timestamp) for time range mode
  specificRelay?: string; // Optional: Only fetch from this relay (for relay-filtered timeline)
  recursionDepth?: number; // Track recursion depth to prevent infinite loops
  exemptFromMuteFilter?: string; // Optional: Pubkey to exempt from mute filtering (for ProfileView)
  config?: TimelineConfig; // The view's typed use-case config. When present, the use
  // case is read from it instead of guessed (e.g. ProfileView via relays.kind),
  // killing the `followingPubkeys.length === 1` heuristic. Absent for legacy
  // callers (e.g. FollowPackManager) which keep today's derivation.
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
  // ProfileView (single author) uses a larger page so each request reaches deep
  // enough that multi-relay pages stay contiguous (Jumble uses 200). Paired with
  // pure `until` pagination and the raw direct fetch.
  private readonly profileFetchLimit = isDataSaverEnabled() ? 100 : 200;
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
  private pollingApplyWordFilter: boolean = true; // Whether the content word-filter applies (config.applyWordFilter)
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
    const params = this.resolveFetchParams(request);
    const isTimeRangeMode = explicitSince !== undefined;

    this.systemLogger.info(
      'FeedOrchestrator',
      params.fetchMode === 'direct'
        ? `Loading profile for ${followingPubkeys[0]?.slice(0, 8)} (direct fetch, no time window)`
        : isTimeRangeMode
          ? `Loading time range ${new Date(explicitSince * 1000).toLocaleDateString()} – ${new Date((explicitUntil ?? Date.now() / 1000) * 1000).toLocaleDateString()}`
          : `Loading timeline for ${followingPubkeys.length} users (${timeWindowHours}h window)${specificRelay ? ` from ${specificRelay}` : ''}`
    );

    try {
      const relays = await this.getRelaysForRequest(followingPubkeys, specificRelay, params.relayStrategy);

      // ProfileView (single author): per-relay paginated fetch. See loadProfileDirect.
      if (params.pagination === 'until' && params.fetchMode === 'direct') {
        return await this.loadProfileDirect(followingPubkeys, relays, includeReplies, exemptFromMuteFilter, request, true);
      }

      // 'until' pagination (ProfileView): direct fetch, limit only, no time window.
      // Time Range Mode: explicit since/until boundaries.
      // 'window' pagination (TimelineView): time-windowed fetch (default 1h).
      let filters: NDKFilter<number>[];
      if (params.pagination === 'until') {
        filters = [{
          authors: followingPubkeys,
          kinds: FEED_KINDS,
          limit: params.pageSize
        }];
        const wc = this.webCommentFilter(followingPubkeys, { limit: params.pageSize }, false);
        if (wc) filters.push(wc);
      } else if (isTimeRangeMode) {
        const filterObj: NDKFilter<number> = {
          authors: followingPubkeys,
          kinds: FEED_KINDS,
          limit: this.fetchLimit,
          since: explicitSince
        };
        if (explicitUntil !== undefined) {
          filterObj.until = explicitUntil;
        }
        filters = [filterObj];
        const wcBounds: { since?: number; until?: number; limit: number } = { since: explicitSince, limit: this.fetchLimit };
        if (explicitUntil !== undefined) wcBounds.until = explicitUntil;
        const wc = this.webCommentFilter(followingPubkeys, wcBounds);
        if (wc) filters.push(wc);
      } else {
        const windowSince = Math.floor(Date.now() / 1000) - (timeWindowHours * 3600);
        filters = [{
          authors: followingPubkeys,
          kinds: FEED_KINDS,
          limit: params.pageSize,
          since: windowSince
        }];
        const wc = this.webCommentFilter(followingPubkeys, { since: windowSince, limit: params.pageSize });
        if (wc) filters.push(wc);
      }

      const events = await this.fetchEvents(relays, filters, params.fetchMode, !!specificRelay);
      const applyWordFilter = request.config ? request.config.applyWordFilter : !exemptFromMuteFilter;
      const filteredEvents = await this.processEvents(events, includeReplies, exemptFromMuteFilter, applyWordFilter);

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

      // Auto-load more if needed (windowed feeds only - 'until' feeds get all via direct fetch)
      const minimumNotes = 10;
      if (params.pagination === 'window' && filteredEvents.length < minimumNotes) {
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
            timeWindowHours: 3, // Load More uses 3h chunks
            ...(request.config ? { config: request.config } : {})
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

      const resultEvents = filteredEvents.slice(0, params.pageSize);
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
    const params = this.resolveFetchParams(request);
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

      const relays = await this.getRelaysForRequest(followingPubkeys, specificRelay, params.relayStrategy);

      // ProfileView (single author): per-relay paginated fetch. See loadProfileDirect.
      if (params.pagination === 'until' && params.fetchMode === 'direct' && !isTimeRangeMode) {
        return await this.loadProfileDirect(followingPubkeys, relays, includeReplies, exemptFromMuteFilter, request, false);
      }

      // 'until' pagination (single author): no `since` window, larger page. The
      // window + small limit fragmented multi-relay pages into gaps. Windowed
      // feeds + time-range keep the windowed page.
      const pureUntil = params.pagination === 'until' && !isTimeRangeMode;
      const filterObj: NDKFilter<number> = {
        authors: followingPubkeys,
        kinds: FEED_KINDS,
        until: until - 1,
        limit: pureUntil ? params.pageSize : 50
      };
      if (!pureUntil) {
        filterObj.since = since;
      }
      const filters: NDKFilter<number>[] = [filterObj];
      if (pureUntil) {
        const wc = this.webCommentFilter(followingPubkeys, { until: until - 1, limit: params.pageSize }, false);
        if (wc) filters.push(wc);
      } else {
        const wc = this.webCommentFilter(followingPubkeys, { since, until: until - 1, limit: 50 });
        if (wc) filters.push(wc);
      }

      const events = await this.fetchEvents(relays, filters, params.fetchMode, !!specificRelay);
      const applyWordFilter = request.config ? request.config.applyWordFilter : !exemptFromMuteFilter;
      const filteredEvents = await this.processEvents(events, includeReplies, exemptFromMuteFilter, applyWordFilter);

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

        // Max recursion depth: 'until' feeds 3 attempts, windowed feeds check time limit
        const maxRecursionDepth = params.pagination === 'until' ? 3 : 56; // until: 3 attempts (9h), window: 56 attempts (7 days)

        if (recursionDepth >= maxRecursionDepth) {
          this.systemLogger.info(
            'FeedOrchestrator',
            params.pagination === 'until'
              ? `📭 No events found after ${recursionDepth} attempts (${Math.round(hoursSinceUntil)}h searched)`
              : '📭 Reached 7-day limit - no more events'
          );
          return {
            events: [],
            hasMore: false
          };
        }

        // Windowed feeds: also check time limit (7 days)
        if (params.pagination === 'window' && hoursSinceUntil >= 168) {
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
          recursionDepth: recursionDepth + 1,
          ...(request.config ? { config: request.config } : {})
        };
        if (specificRelay !== undefined) {
          recursiveRequest.specificRelay = specificRelay;
        }
        return await this.loadMore(recursiveRequest);
      }

      const resultEvents = filteredEvents.slice(0, params.pageSize);
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
   * Per-relay paginated ProfileView state.
   *
   * A single global until-cursor over the union of relays with uneven retention
   * skipped the dense middle of an author's feed: sparse low-retention relays
   * injected a few year-old notes into the first page, which dragged the global
   * cursor back years, so loadMore fetched below them and the dense weeks in
   * between were never requested (the visible "10-day gap").
   *
   * Fix: page every still-active relay from a shared DENSE frontier — the newest
   * timestamp down to which EVERY active relay is fully fetched. Events below the
   * frontier are kept (never lost) and revealed as the frontier descends, so each
   * page handed to the timeline is dense and strictly older than the previous one
   * (the renderer's append-at-bottom invariant stays intact).
   */
  private profilePager: {
    pubkey: string;
    frontier: number | null;            // shared `until` for next round; null = initial (newest)
    done: Set<string>;                  // relays that have returned everything they hold
    stalled: Map<string, number>;       // consecutive empty rounds per relay
    fetched: Map<string, NostrEvent>;   // every event fetched this session (nothing discarded)
    emitted: Set<string>;               // ids already handed to the timeline
  } | null = null;

  /**
   * Core web-comment feed filter: the home/profile feed additionally pulls top-level
   * NIP-22 comments anchored to a web page (NIP-73, lowercase `k:web`) from the same
   * authors, so a user's and their follows' web comments surface inline like any other
   * note. `k` is a single-letter tag, so this is a relay-indexed filter, and
   * `#k:["web"]` matches only top-level web comments (replies to them carry `k:1111`),
   * so no extra filtering is needed. FEED_KINDS stays untouched.
   */
  private webCommentFilter(
    authors: string[],
    bounds: { since?: number; until?: number; limit: number },
    includeSelf: boolean = true
  ): NDKFilter<number> {
    // Home feed: add the current user so their own web comments surface even if they
    // don't follow themselves. Profile feed: scope strictly to the viewed author (never
    // leak the viewer's own web comments into someone else's profile).
    const self = includeSelf ? AuthService.getInstance().getCurrentUser()?.pubkey : undefined;
    const scopedAuthors = self && !authors.includes(self) ? [...authors, self] : authors;
    const filter: NDKFilter<number> = { authors: scopedAuthors, kinds: [1111], '#k': ['web'], limit: bounds.limit };
    if (bounds.since !== undefined) filter.since = bounds.since;
    if (bounds.until !== undefined) filter.until = bounds.until;
    return filter;
  }

  private async loadProfileDirect(
    pubkeys: string[],
    relays: string[],
    includeReplies: boolean,
    exemptFromMuteFilter: string | undefined,
    request: FeedLoadRequest,
    isInitial: boolean
  ): Promise<FeedLoadResult> {
    const pubkey = pubkeys[0] ?? '';
    const pageSize = this.resolveFetchParams(request).pageSize;
    const baseFilter: NDKFilter<number> = {
      authors: pubkeys,
      kinds: FEED_KINDS,
      limit: pageSize
    };
    const pvFilters: NDKFilter<number>[] = [baseFilter];
    const wcPv = this.webCommentFilter(pubkeys, { limit: pageSize }, false);
    if (wcPv) pvFilters.push(wcPv);

    if (isInitial || !this.profilePager || this.profilePager.pubkey !== pubkey) {
      this.profilePager = {
        pubkey,
        frontier: null,
        done: new Set(),
        stalled: new Map(),
        fetched: new Map(),
        emitted: new Set()
      };
    }
    const pager = this.profilePager;

    const newlyEmitted: NostrEvent[] = [];
    const MAX_ROUNDS = 6;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const active = relays.filter(r => !pager.done.has(r));
      if (active.length === 0) break;

      const perRelayUntil: Record<string, number> = {};
      if (pager.frontier !== null) {
        for (const r of active) perRelayUntil[r] = pager.frontier;
      }

      const { events, perRelay } = await this.transport.fetchDirectPaged(active, pvFilters, perRelayUntil, 15000, 'FeedOrch-PV');
      for (const e of events) { if (e.id) pager.fetched.set(e.id, e); }

      // Update exhaustion and collect the frontier candidates (oldest of each
      // relay that still has more to give).
      const frontierCandidates: number[] = [];
      for (const r of active) {
        const info = perRelay[r];
        if (!info) continue;
        if (info.count === 0) {
          // Returned nothing for this cursor. EOSE → fully drained. Otherwise it
          // may have errored/timed out; retire it only after repeated empties so a
          // flaky relay can't stall completion forever.
          const empties = (pager.stalled.get(r) ?? 0) + 1;
          pager.stalled.set(r, empties);
          if (info.eosed || empties >= 2) pager.done.add(r);
          continue;
        }
        pager.stalled.set(r, 0);
        if (info.eosed && info.count < pageSize) {
          pager.done.add(r);           // got all it holds
        }
        if (!pager.done.has(r) && info.oldest !== null) {
          frontierCandidates.push(info.oldest);
        }
      }

      const stillActive = relays.some(r => !pager.done.has(r));
      // Dense frontier: complete coverage reaches down to the deepest point every
      // still-active relay has fetched. With none left, reveal everything.
      const newFrontier = frontierCandidates.length ? Math.max(...frontierCandidates) : null;
      const floor = !stillActive ? Number.NEGATIVE_INFINITY : (newFrontier ?? Number.NEGATIVE_INFINITY);

      for (const e of pager.fetched.values()) {
        if (!e.id || e.created_at === undefined) continue;
        if (!pager.emitted.has(e.id) && e.created_at >= floor) {
          pager.emitted.add(e.id);
          newlyEmitted.push(e);
        }
      }
      pager.frontier = newFrontier;

      if (newlyEmitted.length > 0 || !stillActive) break;
      // Nothing new yet but relays still have history: loop to push the frontier deeper.
    }

    const applyWordFilter = request.config ? request.config.applyWordFilter : !exemptFromMuteFilter;
    const filtered = await this.processEvents(newlyEmitted, includeReplies, exemptFromMuteFilter, applyWordFilter);
    filtered.sort((a, b) => b.created_at - a.created_at);
    this.registerNotes(filtered);

    const hasMore = relays.some(r => !pager.done.has(r));
    // Persist the PV-level outcome to the web ring buffer (see WebDiag). An empty
    // page here (notes:0) next to the matching direct-fetch entry tells the whole
    // #2 story after the fact, even when hit cold with no console open.
    webDiag('pv-page', {
      pubkey: pubkey.slice(0, 8),
      kind: isInitial ? 'initial' : 'more',
      notes: filtered.length,
      relays: relays.length,
      hasMore
    });
    this.systemLogger.info(
      'FeedOrchestrator',
      `Profile ${pubkey.slice(0, 8)}: ${isInitial ? 'initial' : 'more'} page ${filtered.length} notes (frontier ${pager.frontier ? new Date(pager.frontier * 1000).toISOString().slice(0, 10) : 'none'}, hasMore ${hasMore})`
    );

    return { events: filtered, hasMore };
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
    exemptFromMuteFilter: string | undefined,
    applyWordFilter: boolean
  ): Promise<NostrEvent[]> {
    // Deduplicate events by ID
    const uniqueEvents = Array.from(
      new Map(events.map(e => [e.id, e])).values()
    );

    // Filter replies if needed
    let filteredEvents = includeReplies ? uniqueEvents : this.filterReplies(uniqueEvents);

    // Filter muted users
    filteredEvents = await this.filterMutedUsers(filteredEvents, exemptFromMuteFilter);

    // Filter self-reposts (user boosting their own note) when enabled.
    // Applies in ProfileView too — unlike the mute/word filters, the profile
    // owner's exemption does not shield their own self-reposts here.
    if (isHideSelfRepostsEnabled()) {
      filteredEvents = this.filterSelfReposts(filteredEvents);
    }

    // Content word filter (addon) — gated by the config's explicit applyWordFilter
    // flag (false for ProfileView). No longer inferred from the mute exemption.
    if (applyWordFilter) {
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
   * Drop self-reposts: kind:6/16 events where the reposter is the original author.
   * A self-repost is hidden only when the gap between the original note and the
   * repost is below the configured threshold ('all' = hide regardless of gap).
   * If the original timestamp can't be resolved, the repost is kept (we never
   * over-hide on incomplete data). Foreign reposts pass through untouched.
   */
  private filterSelfReposts(events: NostrEvent[]): NostrEvent[] {
    const maxGapSeconds = getSelfRepostGapSeconds();
    let removed = 0;
    const filtered = events.filter(event => {
      if (event.kind !== 6 && event.kind !== 16) return true;

      const inner = this.getRepostedInner(event);
      const originalAuthor = inner?.pubkey ?? event.tags.find(tag => tag[0] === 'p')?.[1] ?? null;
      if (!originalAuthor || originalAuthor !== event.pubkey) return true; // not a self-repost

      // 'all' → hide every self-repost regardless of timing
      if (maxGapSeconds === Infinity) {
        removed++;
        return false;
      }

      // Need the original timestamp to measure the gap — keep if unknown
      if (inner?.created_at == null) return true;

      const gapSeconds = event.created_at - inner.created_at;
      if (gapSeconds < maxGapSeconds) {
        removed++;
        return false;
      }
      return true;
    });
    if (removed > 0) {
      diagLog('system', `Hid ${removed} self-repost(s) from timeline`, {});
    }
    return filtered;
  }

  /**
   * Parse the original event embedded in a repost's content (NIP-18 standard
   * reposts embed the full original event). Returns its pubkey + created_at,
   * or null if content is not a parseable embedded event.
   */
  private getRepostedInner(event: NostrEvent): { pubkey?: string; created_at?: number } | null {
    if (event.content && event.content.trim()) {
      try {
        const inner = JSON.parse(event.content);
        if (inner && typeof inner === 'object') {
          return {
            pubkey: typeof inner.pubkey === 'string' ? inner.pubkey : undefined,
            created_at: typeof inner.created_at === 'number' ? inner.created_at : undefined,
          };
        }
      } catch {
        // content is not an embedded event
      }
    }
    return null;
  }

  /**
   * Resolve the concrete fetch parameters for a request from its TimelineConfig.
   * This is the single place the use case maps to relay/fetch/pagination/page-size
   * — no `isProfileView` guessing elsewhere. Legacy callers without a config fall
   * back to the old length-based derivation, so their behavior is unchanged.
   * See docs/todos/timeline-component-modularization.md.
   */
  private resolveFetchParams(request: FeedLoadRequest): {
    relayStrategy: 'auto' | 'author-outbox';
    fetchMode: 'cache-first' | 'direct';
    pagination: 'window' | 'until';
    pageSize: number;
  } {
    const cfg = request.config;
    if (cfg) {
      return {
        relayStrategy: cfg.relays.kind === 'author-outbox' ? 'author-outbox' : 'auto',
        fetchMode: cfg.fetchMode,
        pagination: cfg.pagination,
        pageSize: cfg.pageSize,
      };
    }
    const isProfileView = request.followingPubkeys.length === 1;
    return {
      relayStrategy: isProfileView ? 'author-outbox' : 'auto',
      fetchMode: isProfileView ? 'direct' : 'cache-first',
      pagination: isProfileView ? 'until' : 'window',
      pageSize: isProfileView ? this.profileFetchLimit : this.fetchLimit,
    };
  }

  /**
   * Get relays for fetching. `author-outbox` uses the author's own write relays
   * (lean, gap-free with the direct fetch); `auto` uses the standard relay set.
   */
  private async getRelaysForRequest(
    followingPubkeys: string[],
    specificRelay: string | undefined,
    relayStrategy: 'auto' | 'author-outbox'
  ): Promise<string[]> {
    if (specificRelay) {
      return [specificRelay];
    }
    if (relayStrategy === 'author-outbox') {
      return await this.relayDiscovery.getProfileRelays(followingPubkeys[0] as string);
    }
    return await this.relayDiscovery.getCombinedRelays(followingPubkeys, false);
  }

  /**
   * Fetch events using the appropriate transport.
   *
   * ProfileView uses a raw, relay-only direct fetch (transport.fetchDirect): a
   * single author's feed must be gap-free, and NDK's fetchEvents pollutes the
   * result with scattered cached/outbox events that corrupt pagination (the
   * oldest such event drags the loadMore cursor far back, skipping whole ranges).
   * Timeline keeps the NDK cache-first fetch for speed.
   */
  private async fetchEvents(
    relays: string[],
    filters: NDKFilter<number>[],
    fetchMode: 'cache-first' | 'direct',
    skipCache: boolean
  ): Promise<NostrEvent[]> {
    if (fetchMode === 'direct') {
      return await this.transport.fetchDirect(relays, filters, 15000, 'FeedOrch-PV');
    }
    return await this.transport.fetch(relays, filters, 5000, skipCache, 'FeedOrch');
  }

  /**
   * "Last notes per follow": the newest qualifying kind-1 note of EACH author.
   *
   * Uses the per-pubkey-limit trick (one filter per author with a small limit — a
   * REQ's `limit` applies per filter, NIP-01), so we get a handful of recent notes
   * per author instead of N total. We fetch a few (not just 1) so that when replies
   * are filtered out (Latest mode), the author's latest ROOT note still surfaces
   * instead of dropping the author whose very latest happened to be a reply.
   *
   * Filters are batched to stay under relays' per-REQ filter caps, fetched with
   * bounded concurrency. The result runs through the central pipeline
   * (dedup/reply/mute/self-repost/word/sort) — exactly the main timeline's filters —
   * then is reduced to one newest note per author and sorted newest-author-first.
   * The CALLER paginates the display.
   *
   * Read-only, derived from the follow list — no polling, no storage, no sync.
   */
  public async loadLatestPerAuthor(
    pubkeys: string[],
    includeReplies: boolean,
    applyWordFilter: boolean
  ): Promise<NostrEvent[]> {
    if (pubkeys.length === 0) return [];

    const relays = await this.getRelaysForRequest(pubkeys, undefined, 'auto');

    /** Notes fetched per author — a few so reply-filtering still leaves a root note. */
    const PER_AUTHOR_LIMIT = 5;
    // Batch so a single REQ stays under the per-REQ filter cap most relays enforce (~10-20).
    const BATCH_SIZE = 15;
    const batches: string[][] = [];
    for (let i = 0; i < pubkeys.length; i += BATCH_SIZE) {
      batches.push(pubkeys.slice(i, i + BATCH_SIZE));
    }

    // Bounded concurrency so hundreds of follows don't open every batch at once.
    const CONCURRENCY = 6;
    const collected: NostrEvent[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < batches.length) {
        const batch = batches[cursor++]!;
        const filters: NDKFilter<number>[] = batch.map(pk => ({ authors: [pk], kinds: [1], limit: PER_AUTHOR_LIMIT }));
        try {
          const events = await this.fetchEvents(relays, filters, 'cache-first', false);
          collected.push(...events);
        } catch (err) {
          this.systemLogger.warn('FeedOrchestrator', `Last-notes batch failed: ${err}`);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker())
    );

    // Central pipeline (dedup → reply → mute → self-repost → word → sort). No mute
    // exemption: this is the user's follows, not their own profile.
    const processed = await this.processEvents(collected, includeReplies, undefined, applyWordFilter);

    // Reduce to ONE newest note per author. `processed` is already newest-first,
    // so the first occurrence of a pubkey is that author's latest note.
    const latestByAuthor = new Map<string, NostrEvent>();
    for (const ev of processed) {
      if (!latestByAuthor.has(ev.pubkey)) latestByAuthor.set(ev.pubkey, ev);
    }
    const result = Array.from(latestByAuthor.values()).sort((a, b) => b.created_at - a.created_at);

    this.registerNotes(result);
    this.systemLogger.info('FeedOrchestrator', `Last notes per follow: ${result.length} authors`);
    return result;
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
    exemptFromMuteFilter?: string,
    applyWordFilter: boolean = true
  ): void {
    // Stop any existing polling
    this.stopPolling();

    this.pollingFollowingPubkeys = followingPubkeys;
    this.lastCheckedTimestamp = lastLoadedTimestamp;
    this.newNotesCallback = callback;
    this.pollingIncludeReplies = includeReplies;
    this.pollingSpecificRelay = specificRelay;
    this.pollingExemptFromMuteFilter = exemptFromMuteFilter;
    this.pollingApplyWordFilter = applyWordFilter;
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
      const filters: NDKFilter<number>[] = [{
        kinds: FEED_KINDS, // Text notes + reposts + polls (NIP-88)
        authors: this.pollingFollowingPubkeys,
        since: this.lastCheckedTimestamp + 1,
        until: now,
        limit: this.pollLimit
      }];
      const wc = this.webCommentFilter(this.pollingFollowingPubkeys, { since: this.lastCheckedTimestamp + 1, until: now, limit: this.pollLimit });
      if (wc) filters.push(wc);

      const events = await this.transport.fetch(relays, filters, 5000, true, 'FeedOrch'); // Skip cache for polling
      const filteredEvents = await this.processEvents(events, this.pollingIncludeReplies, this.pollingExemptFromMuteFilter, this.pollingApplyWordFilter);

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
    exemptFromMuteFilter: string | undefined,
    applyWordFilter: boolean
  ): Promise<NostrEvent[]> {
    try {
      const relays = specificRelay
        ? [specificRelay]
        : this.transport.getReadRelays();

      if (relays.length === 0) return [];

      const now = Math.floor(Date.now() / 1000);
      const filters: NDKFilter<number>[] = [{
        kinds: FEED_KINDS,
        authors: followingPubkeys,
        since: newestTimestamp + 1,
        until: now,
        limit: this.pollLimit
      }];
      const wc = this.webCommentFilter(followingPubkeys, { since: newestTimestamp + 1, until: now, limit: this.pollLimit });
      if (wc) filters.push(wc);

      const events = await this.transport.fetch(relays, filters, 5000, true, 'FeedOrch');
      return await this.processEvents(events, includeReplies, exemptFromMuteFilter, applyWordFilter);
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
