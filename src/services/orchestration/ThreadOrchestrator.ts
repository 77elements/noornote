/**
 * ThreadOrchestrator - Thread/Reply Management
 * Handles reply fetching (children) and parent chain fetching (ancestors)
 *
 * @orchestrator ThreadOrchestrator
 * @purpose Fetch and cache replies + parent chains for notes (SNV, TV, PV)
 * @used-by SingleNoteView, ThreadContextIndicator
 *
 * Architecture:
 * - Fetches replies (kind:1 with #e tag pointing to note) - DOWNWARD
 * - Fetches parent chain (walk up e-tags to root) - UPWARD
 * - Filters out non-replies (mentions)
 * - Cache: 5min TTL
 */

import type { NostrEvent, NDKFilter } from '@nostr-dev-kit/ndk';
import { Orchestrator } from './Orchestrator';
import { NostrTransport } from '../transport/NostrTransport';
import { MuteOrchestrator } from './MuteOrchestrator';
import { AuthService } from '../AuthService';
import { SystemLogger } from '../../components/system/SystemLogger';

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
  private muteOrchestrator: MuteOrchestrator;
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
    this.muteOrchestrator = MuteOrchestrator.getInstance();
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

  private async fetchRepliesFromRelays(noteId: string): Promise<NostrEvent[]> {
    const relays = this.transport.getReadRelays();
    const isAddressable = noteId.includes(':');

    const filters: NDKFilter[] = [{
      kinds: [1],
      ...(isAddressable ? { '#a': [noteId] } : { '#e': [noteId] })
    }];

    try {
      const events = await this.transport.fetch(relays, filters, 5000);
      let actualReplies = events.filter(event => this.isActualReply(event, noteId));

      const currentUser = this.authService.getCurrentUser();
      if (currentUser) {
        const mutedPubkeys = await this.muteOrchestrator.getAllMutedUsers(currentUser.pubkey);
        const mutedSet = new Set(mutedPubkeys);
        actualReplies = actualReplies.filter(event => !mutedSet.has(event.pubkey));
      }

      actualReplies.sort((a, b) => a.created_at - b.created_at);
      return actualReplies;
    } catch (error) {
      this.systemLogger.error(this.LOG_TAG, `Fetch replies failed: ${error}`);
      return [];
    }
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

  private async fetchParentChainFromRelays(noteId: string): Promise<ThreadContext> {
    try {
      const relays = this.transport.getReadRelays();
      const events = await this.transport.fetch(relays, [{ ids: [noteId] }], 5000);

      const firstEvent = events[0];
      if (events.length === 0 || !firstEvent) {
        return this.emptyThreadContext();
      }

      const chain: ThreadContextItem[] = [];
      let noteToProcess: NostrEvent = firstEvent;
      const maxDepth = 50;

      for (let depth = 0; depth < maxDepth; depth++) {
        const parentId = this.extractParentId(noteToProcess);
        if (!parentId || parentId === noteToProcess.id) break;
        if (chain.some(item => item.eventId === parentId)) break;

        const parentEvents = await this.transport.fetch(relays, [{ ids: [parentId] }], 5000);
        const parentNote = parentEvents[0];
        if (parentEvents.length === 0 || !parentNote) break;

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

  private extractParentId(event: NostrEvent): string | null {
    const eTags = event.tags.filter(tag => tag[0] === 'e');
    if (eTags.length === 0) return null;

    const replyTag = eTags.find(tag => tag[3] === 'reply');
    if (replyTag) return replyTag[1] ?? null;

    const firstTag = eTags[0];
    if (eTags.length === 1 && firstTag) return firstTag[1] ?? null;

    const lastTag = eTags[eTags.length - 1];
    return lastTag?.[1] ?? null;
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
      kinds: [1],
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
