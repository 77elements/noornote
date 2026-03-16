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
import { SystemLogger } from '../../components/system/SystemLogger';
import { diagLog } from '../DiagnosticLogger';

export interface ThreadContextItem {
  eventId: string;
  content: string;
  pubkey: string;
  createdAt: number;
  tags: string[][];
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

  private repliesMetaCache: Map<string, { replyIds: string[]; lastUpdated: number }> = new Map();
  private fetchingReplies: Map<string, Promise<NostrEvent[]>> = new Map();
  private parentChainCache: Map<string, { context: ThreadContext; lastUpdated: number }> = new Map();
  private fetchingParentChain: Map<string, Promise<ThreadContext>> = new Map();
  private liveSubscriptions: Map<string, string> = new Map();

  private readonly cacheDuration = 5 * 60 * 1000;
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
    return { root: null, parents: [], directParent: null, hasSkippedReplies: false };
  }

  public async fetchReplies(noteId: string): Promise<NostrEvent[]> {
    if (this.fetchingReplies.has(noteId)) {
      return await this.fetchingReplies.get(noteId)!;
    }

    const fetchPromise = this.fetchRepliesFromRelays(noteId);
    this.fetchingReplies.set(noteId, fetchPromise);

    try {
      const replies = await fetchPromise;
      this.repliesMetaCache.set(noteId, {
        replyIds: replies.map(r => r.id).filter((id): id is string => id !== undefined),
        lastUpdated: Date.now()
      });
      return replies;
    } finally {
      this.fetchingReplies.delete(noteId);
    }
  }

  /**
   * Fetch replies with 2-stage strategy: read relays → outbound relays of note author
   */
  private async fetchRepliesFromRelays(noteId: string): Promise<NostrEvent[]> {
    const isAddressable = noteId.includes(':');
    const filters: NDKFilter[] = [{
      kinds: [1, 1111],
      ...(isAddressable ? { '#a': [noteId] } : { '#e': [noteId] })
    }];

    const allReplies = new Map<string, NostrEvent>();

    // Stage 1: Read relays
    const relays = this.transport.getReadRelays();
    try {
      const events = await this.transport.fetch(relays, filters, 5000);
      events.forEach(e => { if (e.id) allReplies.set(e.id, e); });
    } catch (error) {
      this.systemLogger.error(this.LOG_TAG, `Stage 1 replies failed: ${error}`);
    }

    // Stage 2: Outbound relays of the note's author (replies often land on same relays)
    const note = this.noteService.getCachedNote(noteId);
    if (note) {
      try {
        const outboundRelays = await this.relayDiscovery.getCombinedRelays([note.pubkey], true);
        const newRelays = outboundRelays.filter(r => !relays.includes(r));

        // Pre-connect to new outbound relays (NDK may not connect to unknown relays via relayUrls)
        if (newRelays.length > 0) {
          await Promise.allSettled(newRelays.map(r => this.transport.connectToRelay(r, 5000)));
        }

        const outboundEvents = await this.transport.fetch(outboundRelays, filters, 8000, true);
        const countBefore = allReplies.size;
        outboundEvents.forEach(e => { if (e.id && !allReplies.has(e.id)) allReplies.set(e.id, e); });
        const newFromOutbound = allReplies.size - countBefore;
        if (newFromOutbound > 0) {
          diagLog('relays', 'ThreadOrchestrator: outbound fallback found additional replies', {
            noteId: noteId.slice(0, 8),
            newReplies: newFromOutbound
          });
        }
      } catch {
        // Outbound fallback failed, continue with what we have
      }
    }

    // Filter and sort
    let actualReplies = Array.from(allReplies.values()).filter(event => this.isActualReply(event, noteId));

    const currentUser = this.authService.getCurrentUser();
    if (currentUser) {
      const mutedPubkeys = await this.muteOrchestrator.getAllMutedUsers(currentUser.pubkey);
      const mutedSet = new Set(mutedPubkeys);
      actualReplies = actualReplies.filter(event => !mutedSet.has(event.pubkey));
    }

    actualReplies.sort((a, b) => a.created_at - b.created_at);

    // Register replies in NoteService for later reuse
    this.noteService.registerNotes(actualReplies);

    return actualReplies;
  }

  private isActualReply(event: NostrEvent, noteId: string): boolean {
    const isAddressable = noteId.includes(':');
    const tagType = isAddressable ? 'a' : 'e';
    const tags = event.tags.filter(tag => tag[0] === tagType);
    return tags.length > 0 && tags.some(tag => tag[1] === noteId);
  }

  public async fetchParentChain(noteId: string): Promise<ThreadContext> {
    const cached = this.parentChainCache.get(noteId);
    if (cached && Date.now() - cached.lastUpdated < this.cacheDuration) {
      return cached.context;
    }

    if (this.fetchingParentChain.has(noteId)) {
      return await this.fetchingParentChain.get(noteId)!;
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
  private async fetchParentChainFromRelays(noteId: string): Promise<ThreadContext> {
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

        // Try NoteService cache first (uses aggregator relays)
        let parentNote = await this.noteService.getNote(parentRef.id);

        // Outbound fallback: relay hints + child author's outbound relays
        if (!parentNote) {
          parentNote = await this.fetchNoteWithOutbound(parentRef.id, parentRef.relayHint, noteToProcess.pubkey);
        }

        if (!parentNote) break;

        chain.push({
          eventId: parentNote.id ?? '',
          content: parentNote.content,
          pubkey: parentNote.pubkey,
          createdAt: parentNote.created_at,
          tags: parentNote.tags
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
        hasSkippedReplies: parents.length > 0
      };
    } catch (error) {
      this.systemLogger.error(this.LOG_TAG, `Fetch parent chain failed: ${error}`);
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
        await this.transport.connectToRelay(relayHint, 5000);
        const events = await this.transport.fetch([relayHint], [filter], 5000, true);
        if (events[0]) {
          diagLog('relays', 'ThreadOrchestrator: relay hint found parent note', {
            eventId: eventId.slice(0, 8),
            relay: relayHint
          });
          this.noteService.registerNotes([events[0]]);
          return events[0];
        }
      } catch {
        // Hint relay failed, continue
      }
    }

    // Try outbound relays of the child's author (they likely share relays with the parent)
    try {
      const outboundRelays = await this.relayDiscovery.getCombinedRelays([knownAuthorPubkey], true);
      const standardRelays = this.transport.getReadRelays();
      const newRelays = outboundRelays.filter(r => !standardRelays.includes(r));

      // Pre-connect to new outbound relays
      if (newRelays.length > 0) {
        await Promise.allSettled(newRelays.map(r => this.transport.connectToRelay(r, 5000)));
      }

      const events = await this.transport.fetch(outboundRelays, [filter], 8000, true);
      if (events[0]) {
        diagLog('relays', 'ThreadOrchestrator: outbound fallback found parent note', {
          eventId: eventId.slice(0, 8),
          childAuthor: knownAuthorPubkey.slice(0, 8)
        });
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
  private extractParentRef(event: NostrEvent): { id: string; relayHint: string | null } | null {
    // NIP-22: kind:1111 uses lowercase 'e' tag for parent reference
    if (event.kind === 1111) {
      const parentETag = event.tags.find(t => t[0] === 'e');
      if (!parentETag?.[1]) return null;
      return { id: parentETag[1], relayHint: parentETag[2] || null };
    }

    // NIP-10: kind:1 uses e-tags with markers
    const eTags = event.tags.filter(tag => tag[0] === 'e');
    if (eTags.length === 0) return null;

    // Prefer 'reply' marker
    const replyTag = eTags.find(tag => tag[3] === 'reply');
    if (replyTag?.[1]) return { id: replyTag[1], relayHint: replyTag[2] || null };

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

  public startLiveReplies(noteId: string, callback: (event: NostrEvent) => void): void {
    if (this.liveSubscriptions.has(noteId)) {
      this.systemLogger.warn(this.LOG_TAG, `Already subscribed to ${noteId}, restarting`);
      this.stopLiveReplies(noteId);
    }

    const relays = this.transport.getReadRelays();
    const subId = `live-replies-${noteId}`;

    const filters: NDKFilter[] = [{
      kinds: [1, 1111],
      '#e': [noteId],
      since: Math.floor(Date.now() / 1000)
    }];

    this.transport.subscribeLive(relays, filters, subId, (event) => {
      if (this.isActualReply(event, noteId)) {
        this.systemLogger.info(this.LOG_TAG, `New live reply for ${noteId}: ${event.id}`);

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
      this.systemLogger.warn(this.LOG_TAG, `No live subscription for ${noteId}`);
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
    this.systemLogger.error(this.LOG_TAG, `Relay error (${relay}): ${error.message}`);
  }

  public override destroy(): void {
    this.liveSubscriptions.forEach((subId, noteId) => {
      this.transport.unsubscribeLive(subId);
      this.systemLogger.info(this.LOG_TAG, `Stopped live subscription for ${noteId}`);
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
