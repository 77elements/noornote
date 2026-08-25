/**
 * ThreadOrchestrator - Thread/Reply Management
 * Handles reply fetching (children) and parent chain fetching (ancestors)
 *
 * @orchestrator ThreadOrchestrator
 * @purpose Fetch and cache replies + parent chains for notes (SNV, TV, PV)
 * @used-by SingleNoteView, ThreadContextIndicator
 *
 * Architecture:
 * - Fetches replies (kind:1 + kind:1111 with #e tag pointing to note) - DOWNWARD
 * - Fetches parent chain (walk up e-tags to root) - UPWARD
 * - 2-stage relay strategy: read relays → outbound relays (NIP-65)
 * - Filters out non-replies (mentions)
 * - Cache: 5min TTL
 */

import type { NostrEvent, NDKFilter } from '@nostr-dev-kit/ndk';
import { Orchestrator } from './Orchestrator';
import { NostrTransport } from '../transport/NostrTransport';
import { OutboundRelaysOrchestrator } from './OutboundRelaysOrchestrator';
import { MuteOrchestrator } from '../../lists/mutes';
import { NoteService } from '../NoteService';
import { AuthService } from '../AuthService';
import { SystemLogger } from '../SystemLogger';
import { diagLog } from '../DiagnosticLogger';
import { LRUCache, getCacheSize } from '../../helpers/LRUCache';

export interface ThreadContextItem {
  eventId: string;
  content: string;
  pubkey: string;
  createdAt: number;
  tags: string[][];
  kind: number;
}

export interface ThreadContext {
  root: ThreadContextItem | null;
  parents: ThreadContextItem[];
  directParent: ThreadContextItem | null;
  hasSkippedReplies: boolean;
}

export class ThreadOrchestrator extends Orchestrator {
  private static instance: ThreadOrchestrator;
  private transport: NostrTransport;
  private relayDiscovery: OutboundRelaysOrchestrator;
  private muteOrchestrator: ReturnType<typeof MuteOrchestrator.getInstance>;
  private noteService: NoteService;
  private authService: AuthService;
  private systemLogger: SystemLogger;

  private readonly cacheDuration = 5 * 60 * 1000;
  private repliesMetaCache = new LRUCache<{
    replyIds: string[];
    lastUpdated: number;
  }>(getCacheSize(200, 100, 50), this.cacheDuration);
  private fetchingReplies: Map<string, Promise<NostrEvent[]>> = new Map();
  private parentChainCache = new LRUCache<{
    context: ThreadContext;
    lastUpdated: number;
  }>(getCacheSize(200, 100, 50), this.cacheDuration);
  private fetchingParentChain: Map<string, Promise<ThreadContext>> = new Map();
  private liveSubscriptions: Map<string, string> = new Map();
  private readonly LOG_TAG = 'ThreadOrchestrator';

  private constructor() {
    super('ThreadOrchestrator');
    this.transport = NostrTransport.getInstance();
    this.relayDiscovery = OutboundRelaysOrchestrator.getInstance();
    this.muteOrchestrator = MuteOrchestrator.getInstance();
    this.noteService = NoteService.getInstance();
    this.authService = AuthService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.systemLogger.info(this.LOG_TAG, 'Initialized');
  }

  public static getInstance(): ThreadOrchestrator {
    if (!ThreadOrchestrator.instance) {
      ThreadOrchestrator.instance = new ThreadOrchestrator();
    }
    return ThreadOrchestrator.instance;
  }

  private emptyThreadContext(): ThreadContext {
    return {
      root: null,
      parents: [],
      directParent: null,
      hasSkippedReplies: false,
    };
  }

  public async fetchReplies(
    noteId: string,
    authorPubkey?: string
  ): Promise<NostrEvent[]> {
    if (this.fetchingReplies.has(noteId)) {
      return this.fetchingReplies.get(noteId)!;
    }

    const fetchPromise = this.fetchRepliesFromRelays(noteId, authorPubkey);
    this.fetchingReplies.set(noteId, fetchPromise);

    try {
      const replies = await fetchPromise;
      this.repliesMetaCache.set(noteId, {
        replyIds: replies
          .map(r => r.id)
          .filter((id): id is string => id !== undefined),
        lastUpdated: Date.now(),
      });
      return replies;
    } finally {
      this.fetchingReplies.delete(noteId);
    }
  }

  /**
   * Fetch replies with 2-stage strategy: read relays → outbound relays of note author.
   * hintedAuthorPubkey lets callers (SNV) supply the note author directly so stage 2
   * runs even when the note isn't in NoteService cache — e.g. a public note opened cold
   * from an external link while logged out, where read relays are sparse.
   */
  private async fetchRepliesFromRelays(
    noteId: string,
    hintedAuthorPubkey?: string
  ): Promise<NostrEvent[]> {
    const isAddressable = noteId.includes(':');
    const filterLowerA: NDKFilter[] = isAddressable
      ? [{ kinds: [1, 1111], '#a': [noteId] }]
      : [{ kinds: [1, 1111], '#e': [noteId] }];

    // NIP-22 comments use uppercase A tag as root scope
    const filterUpperA: NDKFilter[] = isAddressable
      ? [{ kinds: [1, 1111], '#A': [noteId] }]
      : [];

    const allReplies = new Map<string, NostrEvent>();

    // Stage 1: Read relays
    const relays = this.transport.getReadRelays();
    try {
      const fetches = [
        this.transport.fetch(relays, filterLowerA, 5000, false, 'ThreadOrch'),
      ];
      if (filterUpperA.length > 0) {
        fetches.push(
          this.transport.fetch(
            relays,
            filterUpperA,
            5000,
            false,
            'ThreadOrch-A'
          )
        );
      }
      const results = await Promise.all(fetches);
      results.flat().forEach(e => {
        if (e.id) allReplies.set(e.id, e);
      });
    } catch (error) {
      this.systemLogger.error(this.LOG_TAG, `Stage 1 replies failed: ${String(error)}`);
    }

    // Stage 2: Outbound relays of the note's author (replies often land on same relays)
    // For addressable events (kind:pubkey:d-tag), extract pubkey directly from the identifier
    const authorPubkey = isAddressable
      ? noteId.split(':')[1]
      : (hintedAuthorPubkey ?? this.noteService.getCachedNote(noteId)?.pubkey);
    if (authorPubkey) {
      try {
        const outboundRelays = await this.relayDiscovery.getCombinedRelays(
          [authorPubkey],
          true
        );

        const outFetches = [
          this.transport.fetch(
            outboundRelays,
            filterLowerA,
            8000,
            true,
            'ThreadOrch'
          ),
        ];
        if (filterUpperA.length > 0) {
          outFetches.push(
            this.transport.fetch(
              outboundRelays,
              filterUpperA,
              8000,
              true,
              'ThreadOrch-A'
            )
          );
        }
        const outboundEvents = (await Promise.all(outFetches)).flat();
        const countBefore = allReplies.size;
        outboundEvents.forEach(e => {
          if (e.id && !allReplies.has(e.id)) allReplies.set(e.id, e);
        });
        const newFromOutbound = allReplies.size - countBefore;
        if (newFromOutbound > 0) {
          diagLog(
            'relays',
            'ThreadOrchestrator: outbound fallback found additional replies',
            {
              noteId: noteId.slice(0, 8),
              newReplies: newFromOutbound,
            }
          );
        }
      } catch {
        // Outbound fallback failed, continue with what we have
      }
    }

    // Filter and sort
    let actualReplies = Array.from(allReplies.values()).filter(event =>
      this.isActualReply(event, noteId)
    );

    const currentUser = this.authService.getCurrentUser();
    if (currentUser) {
      const mutedPubkeys = this.muteOrchestrator.getAllMutedUsers(
        currentUser.pubkey
      );
      const mutedSet = new Set(mutedPubkeys);
      actualReplies = actualReplies.filter(
        event => !mutedSet.has(event.pubkey)
      );
    }

    actualReplies.sort((a, b) => a.created_at - b.created_at);

    // Register replies in NoteService for later reuse
    this.noteService.registerNotes(actualReplies);

    return actualReplies;
  }

  private isActualReply(event: NostrEvent, noteId: string): boolean {
    const isAddressable = noteId.includes(':');
    if (isAddressable) {
      // NIP-01 uses lowercase 'a', NIP-22 uses uppercase 'A' for root scope
      const tags = event.tags.filter(
        tag => (tag[0] === 'a' || tag[0] === 'A') && tag[1] === noteId
      );
      return tags.length > 0;
    }
    const tags = event.tags.filter(tag => tag[0] === 'e' && tag[1] === noteId);
    return tags.length > 0;
  }

  public async fetchParentChain(noteId: string): Promise<ThreadContext> {
    const cached = this.parentChainCache.get(noteId);
    if (cached) {
      return cached.context;
    }

    if (this.fetchingParentChain.has(noteId)) {
      return this.fetchingParentChain.get(noteId)!;
    }

    const fetchPromise = this.fetchParentChainFromRelays(noteId);
    this.fetchingParentChain.set(noteId, fetchPromise);

    try {
      const context = await fetchPromise;
      this.parentChainCache.set(noteId, { context, lastUpdated: Date.now() });
      return context;
    } finally {
      this.fetchingParentChain.delete(noteId);
    }
  }

  /**
   * Walk parent chain upward with outbound relay fallback
   * When NoteService.getNote() fails (aggregator-only), try:
   * 1. Relay hints from e-tag (NIP-10)
   * 2. Outbound relays of the child note's author
   */
  private async fetchParentChainFromRelays(
    noteId: string
  ): Promise<ThreadContext> {
    try {
      // Try NoteService cache first, then fetch
      const firstEvent = await this.noteService.getNote(noteId);

      if (!firstEvent) {
        return this.emptyThreadContext();
      }

      const chain: ThreadContextItem[] = [];
      let noteToProcess: NostrEvent = firstEvent;
      const maxDepth = 50;

      for (let depth = 0; depth < maxDepth; depth++) {
        const parentRef = this.extractParentRef(noteToProcess);
        if (!parentRef || parentRef.id === noteToProcess.id) break;
        if (chain.some(item => item.eventId === parentRef.id)) break;

        const isAddressable = parentRef.id.includes(':');
        let parentNote: NostrEvent | null = null;

        if (isAddressable) {
          // Addressable coordinate "kind:pubkey:dtag" — fetch via filter
          parentNote = await this.fetchAddressableParent(
            parentRef.id,
            parentRef.relayHint,
            noteToProcess.pubkey
          );
        } else {
          // Hex event id — try NoteService cache first, then outbound fallback
          parentNote = await this.noteService.getNote(parentRef.id);
          if (!parentNote) {
            parentNote = await this.fetchNoteWithOutbound(
              parentRef.id,
              parentRef.relayHint,
              noteToProcess.pubkey
            );
          }
        }

        if (!parentNote) break;

        chain.push({
          eventId: parentNote.id ?? '',
          content: parentNote.content,
          pubkey: parentNote.pubkey,
          createdAt: parentNote.created_at,
          tags: parentNote.tags,
          kind: parentNote.kind ?? 1,
        });

        noteToProcess = parentNote;
      }

      const directParent = chain[0];
      if (chain.length === 0 || !directParent) {
        return this.emptyThreadContext();
      }

      const root = chain[chain.length - 1];
      const parents = chain.slice(1, -1);

      return {
        root: chain.length > 1 && root ? root : null,
        parents,
        directParent,
        hasSkippedReplies: parents.length > 0,
      };
    } catch (error) {
      this.systemLogger.error(
        this.LOG_TAG,
        `Fetch parent chain failed: ${String(error)}`
      );
      return this.emptyThreadContext();
    }
  }

  /**
   * Fetch a single note using relay hints + outbound relays of a known author
   */
  private async fetchNoteWithOutbound(
    eventId: string,
    relayHint: string | null,
    knownAuthorPubkey: string
  ): Promise<NostrEvent | null> {
    const filter: NDKFilter = { ids: [eventId], limit: 1 };

    // Try relay hint first (fastest, most targeted)
    if (relayHint) {
      try {
        const events = await this.transport.fetch(
          [relayHint],
          [filter],
          5000,
          true,
          'ThreadOrch'
        );
        if (events[0]) {
          diagLog(
            'relays',
            'ThreadOrchestrator: relay hint found parent note',
            {
              eventId: eventId.slice(0, 8),
              relay: relayHint,
            }
          );
          this.noteService.registerNotes([events[0]]);
          return events[0];
        }
      } catch {
        // Hint relay failed, continue
      }
    }

    // Try outbound relays of the child's author (they likely share relays with the parent)
    try {
      const outboundRelays = await this.relayDiscovery.getCombinedRelays(
        [knownAuthorPubkey],
        true
      );
      const events = await this.transport.fetch(
        outboundRelays,
        [filter],
        8000,
        true,
        'ThreadOrch'
      );
      if (events[0]) {
        diagLog(
          'relays',
          'ThreadOrchestrator: outbound fallback found parent note',
          {
            eventId: eventId.slice(0, 8),
            childAuthor: knownAuthorPubkey.slice(0, 8),
          }
        );
        this.noteService.registerNotes([events[0]]);
        return events[0];
      }
    } catch {
      // Outbound failed
    }

    return null;
  }

  /**
   * Fetch an addressable event by its coordinate "kind:pubkey:dtag".
   * Used by NIP-22 (kind:1111) comments whose parent is an article (kind:30023)
   * or any other addressable event referenced via 'a'/'A' tag.
   */
  private async fetchAddressableParent(
    coordinate: string,
    relayHint: string | null,
    knownAuthorPubkey: string
  ): Promise<NostrEvent | null> {
    const parts = coordinate.split(':');
    const kindStr = parts[0];
    const pubkey = parts[1];
    const dtag = parts.slice(2).join(':'); // dtag may itself contain colons
    if (!kindStr || !pubkey) return null;

    const kind = parseInt(kindStr, 10);
    if (Number.isNaN(kind)) return null;

    const filter: NDKFilter = { kinds: [kind], authors: [pubkey], limit: 1 };
    if (dtag) {
      (filter as NDKFilter<number> & Record<string, unknown>)['#d'] = [dtag];
    }

    if (relayHint) {
      try {
        const events = await this.transport.fetch(
          [relayHint],
          [filter],
          5000,
          true,
          'ThreadOrch'
        );
        if (events[0]) {
          diagLog(
            'relays',
            'ThreadOrchestrator: relay hint found addressable parent',
            {
              coord: coordinate.slice(0, 30),
              relay: relayHint,
            }
          );
          this.noteService.registerNotes([events[0]]);
          return events[0];
        }
      } catch {
        // Hint relay failed, continue
      }
    }

    try {
      const outboundRelays = await this.relayDiscovery.getCombinedRelays(
        [pubkey, knownAuthorPubkey],
        true
      );
      const events = await this.transport.fetch(
        outboundRelays,
        [filter],
        8000,
        true,
        'ThreadOrch'
      );
      if (events[0]) {
        diagLog(
          'relays',
          'ThreadOrchestrator: outbound fallback found addressable parent',
          {
            coord: coordinate.slice(0, 30),
            authorPubkey: pubkey.slice(0, 8),
          }
        );
        this.noteService.registerNotes([events[0]]);
        return events[0];
      }
    } catch {
      // Outbound failed
    }

    return null;
  }

  /**
   * Extract parent event ID and optional relay hint from e-tags
   */
  private extractParentRef(
    event: NostrEvent
  ): { id: string; relayHint: string | null } | null {
    // NIP-22: kind:1111 uses lowercase 'e' for parent on regular notes,
    // or lowercase 'a' (fallback uppercase 'A' for top-level) on addressable parents.
    if (event.kind === 1111) {
      const parentETag = event.tags.find(t => t[0] === 'e');
      if (parentETag?.[1])
        return { id: parentETag[1], relayHint: parentETag[2] || null };

      const parentATag =
        event.tags.find(t => t[0] === 'a') ??
        event.tags.find(t => t[0] === 'A');
      if (parentATag?.[1])
        return { id: parentATag[1], relayHint: parentATag[2] || null };

      return null;
    }

    // NIP-10: kind:1 uses e-tags with markers.
    // Exclude quote references so a quoted note never appears as a reply parent
    // in the thread-context chain (e.g. replies to a quote-repost must not show
    // the quoted note above the QR author). Mirrors NoorNote's canonical quote
    // detection (NoteStructureBuilder / RepliesRenderer / ThreadManager):
    //   - NIP-10 "mention"-marked e-tags are citations, not reply parents
    //   - NIP-18 'q'-tag targets are quotes, not reply parents
    const quotedIds = new Set(
      event.tags.filter(tag => tag[0] === 'q' && tag[1]).map(tag => tag[1])
    );
    const eTags = event.tags.filter(
      tag => tag[0] === 'e' && tag[3] !== 'mention' && !quotedIds.has(tag[1])
    );
    if (eTags.length === 0) {
      // Legacy NIP-10 style on addressable parents (Yakihonne, Highlighter):
      // kind:1 reply with only an 'a' tag. Require an explicit "reply" or
      // "root" marker to distinguish real replies from NIP-18 quote-posts
      // (which use bare 'a' tags for tagging purposes only and render the
      // parent inline in the body — indicator would duplicate).
      if (event.kind === 1) {
        const parentATag =
          event.tags.find(t => t[0] === 'a' && t[3] === 'reply') ??
          event.tags.find(t => t[0] === 'a' && t[3] === 'root');
        if (parentATag?.[1])
          return { id: parentATag[1], relayHint: parentATag[2] || null };
      }
      return null;
    }

    // Prefer 'reply' marker
    const replyTag = eTags.find(tag => tag[3] === 'reply');
    if (replyTag?.[1])
      return { id: replyTag[1], relayHint: replyTag[2] || null };

    // Single e-tag = parent
    if (eTags.length === 1 && eTags[0]?.[1]) {
      return { id: eTags[0][1], relayHint: eTags[0][2] || null };
    }

    // Last e-tag = parent (deprecated NIP-10 positional)
    const lastTag = eTags[eTags.length - 1];
    if (lastTag?.[1]) return { id: lastTag[1], relayHint: lastTag[2] || null };

    return null;
  }

  public clearCache(noteId: string): void {
    this.repliesMetaCache.delete(noteId);
    this.parentChainCache.delete(noteId);
  }

  public clearAllCache(): void {
    this.repliesMetaCache.clear();
    this.parentChainCache.clear();
  }

  public startLiveReplies(
    noteId: string,
    callback: (event: NostrEvent) => void
  ): void {
    if (this.liveSubscriptions.has(noteId)) {
      this.systemLogger.warn(
        this.LOG_TAG,
        `Already subscribed to ${noteId}, restarting`
      );
      this.stopLiveReplies(noteId);
    }

    const relays = this.transport.getReadRelays();
    const subId = `live-replies-${noteId}`;
    const isAddressable = noteId.includes(':');

    // Addressable events (NIP-33, kinds 30000–39999) are referenced via #a /
    // #A tags by NIP-22 comments and legacy replies; hex ids use #e.
    const filters: NDKFilter[] = isAddressable
      ? [
          {
            kinds: [1, 1111],
            '#a': [noteId],
            since: Math.floor(Date.now() / 1000),
          },
          {
            kinds: [1, 1111],
            '#A': [noteId],
            since: Math.floor(Date.now() / 1000),
          },
        ]
      : [
          {
            kinds: [1, 1111],
            '#e': [noteId],
            since: Math.floor(Date.now() / 1000),
          },
        ];

    void this.transport.subscribeLive(relays, filters, subId, event => {
      if (this.isActualReply(event, noteId)) {
        this.systemLogger.info(
          this.LOG_TAG,
          `New live reply for ${noteId}: ${event.id}`
        );

        const cached = this.repliesMetaCache.get(noteId);
        if (cached && event.id) {
          cached.replyIds.push(event.id);
          cached.lastUpdated = Date.now();
        }

        callback(event);
      }
    });

    this.liveSubscriptions.set(noteId, subId);
    this.systemLogger.info(this.LOG_TAG, `Live replies started for ${noteId}`);
  }

  public stopLiveReplies(noteId: string): void {
    const subId = this.liveSubscriptions.get(noteId);
    if (!subId) {
      this.systemLogger.warn(
        this.LOG_TAG,
        `No live subscription for ${noteId}`
      );
      return;
    }

    this.transport.unsubscribeLive(subId);
    this.liveSubscriptions.delete(noteId);
    this.systemLogger.info(this.LOG_TAG, `Live replies stopped for ${noteId}`);
  }

  public onui(): void {}
  public onopen(): void {}
  public onmessage(): void {}
  public onclose(): void {}

  public onerror(relay: string, error: Error): void {
    this.systemLogger.error(
      this.LOG_TAG,
      `Relay error (${relay}): ${error.message}`
    );
  }

  public override destroy(): void {
    this.liveSubscriptions.forEach((subId, noteId) => {
      this.transport.unsubscribeLive(subId);
      this.systemLogger.info(
        this.LOG_TAG,
        `Stopped live subscription for ${noteId}`
      );
    });
    this.liveSubscriptions.clear();

    this.repliesMetaCache.clear();
    this.fetchingReplies.clear();
    this.parentChainCache.clear();
    this.fetchingParentChain.clear();
    super.destroy();
    this.systemLogger.info(this.LOG_TAG, 'Destroyed');
  }
}
