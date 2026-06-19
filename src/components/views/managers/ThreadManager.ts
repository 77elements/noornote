/**
 * ThreadManager
 * Handles thread/reply management for SingleNoteView:
 * - Fetching replies
 * - Building thread tree
 * - Rendering threaded replies with nesting
 * - Live reply updates
 */

import { NoteUI } from '../../ui/NoteUI';
import { ModuleLoader } from '../../../core/ModuleLoader';
import type { SingleNoteModuleApi } from '../../../modules/single-note/contracts';
import type { ReactionsModuleApi } from '../../../modules/reactions/contracts';
import { AuthService } from '../../../services/AuthService';
import { SystemLogger } from '../../../services/SystemLogger';
import { UserProfileService } from '../../../services/UserProfileService';
import { RelayConfig } from '../../../services/RelayConfig';
import { Router } from '../../../services/Router';
import { LayoutService } from '../../../services/LayoutService';
import { encodeNevent } from '../../../services/NostrToolsAdapter';
import { escapeHtml } from '../../../helpers/escapeHtml';
import { fetchNostrEvents } from '../../../helpers/fetchNostrEvents';
import { filterVisibleEvents } from '../../../lists/mutes';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

export interface ThreadNode {
  event: NostrEvent;
  children: ThreadNode[];
  depth: number;
}

export interface ThreadManagerConfig {
  noteId: string;
  noteAuthor: string;
  container: HTMLElement;
  onStatsUpdate?: (replies: number, quotedReposts: number) => void;
  onLoadZapsList?: (replyId: string, authorPubkey: string, element: HTMLElement) => void;
}

export class ThreadManager {
  private config: ThreadManagerConfig;
  private _reactionsApi?: ReactionsModuleApi | null;
  private get reactionsApi(): ReactionsModuleApi | null {
    return this._reactionsApi ??= ModuleLoader.getInstance().getApi<ReactionsModuleApi>('reactions');
  }
  private authService: AuthService;
  private systemLogger: SystemLogger;
  private profileService: UserProfileService;
  private relayConfig: RelayConfig;

  constructor(config: ThreadManagerConfig) {
    this.config = config;
    this.authService = AuthService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.profileService = UserProfileService.getInstance();
    this.relayConfig = RelayConfig.getInstance();
  }

  private getRepliesContainer(): Element | null {
    return this.config.container.querySelector('.snv-replies-container');
  }

  private getRepliesList(): Element | null {
    return this.config.container.querySelector('.snv-replies__list');
  }

  public async fetchQuotedReposts(): Promise<NostrEvent[]> {
    const relays = this.relayConfig.getReadRelays();

    this.systemLogger.info('ThreadManager', `Fetching quoted reposts for note ${this.config.noteId.slice(0, 8)}`);

    try {
      // Two relay queries in parallel: NIP-18 q-tag AND legacy e-tag-with-mention
      // (Primal-iOS pre-NIP-18 pattern). Tag-OR can't be expressed in one filter.
      const [qTagResult, eTagResult] = await Promise.all([
        fetchNostrEvents({ relays, kinds: [1, 6], tags: { 'q': [this.config.noteId] }, limit: 100 }),
        fetchNostrEvents({ relays, kinds: [1], tags: { 'e': [this.config.noteId] }, limit: 100 })
      ]);

      const byId = new Map<string, NostrEvent>();
      for (const ev of [...qTagResult.events, ...eTagResult.events]) {
        if (ev.id) byId.set(ev.id, ev);
      }

      const quotedReposts = Array.from(byId.values()).filter(event => {
        const hasContent = event.content.trim().length > 0;
        if (!hasContent) return false;

        if (event.tags.some(tag => tag[0] === 'q' && tag[1] === this.config.noteId)) return true;

        const eTags = event.tags.filter(tag => tag[0] === 'e' && tag[1] === this.config.noteId);
        return eTags.some(tag => tag[3] === 'mention')
          && /nostr:(nevent1|note1|naddr1)/.test(event.content);
      });

      // Drop QRs from muted authors at fetch time so the displayed count
      // ("Replies & Quotes (N)") matches what the user actually sees. The
      // NoteUI render-time guard is the fail-safe, but pre-filtering keeps
      // counts honest.
      const visibleQuotedReposts = filterVisibleEvents(quotedReposts);

      this.systemLogger.info('ThreadManager', `Fetched reposts: ${qTagResult.events.length + eTagResult.events.length}, quoted: ${quotedReposts.length}, visible: ${visibleQuotedReposts.length}`);
      return visibleQuotedReposts;
    } catch (error) {
      this.systemLogger.error('ThreadManager', `Failed to fetch quoted reposts: ${error}`);
      return [];
    }
  }

  public async loadReplies(quotedReposts: NostrEvent[]): Promise<void> {
    const repliesContainer = this.getRepliesContainer();
    if (!repliesContainer) return;

    repliesContainer.innerHTML = `
      <div class="snv-replies__loading">
        <div class="loading-spinner"></div>
        <p>Loading replies...</p>
      </div>
    `;

    try {
      // ensure() so replies load on public, logged-out note views (the
      // single-note module activates on login; reading replies needs no auth).
      const singleNoteApi = await ModuleLoader.getInstance().ensure<SingleNoteModuleApi>('single-note');
      const allReplies = await singleNoteApi?.fetchReplies(this.config.noteId, this.config.noteAuthor) ?? [];

      const filteredQuotedReposts = quotedReposts.filter(q => q.pubkey !== this.config.noteAuthor);
      const quotedRepostIds = new Set(filteredQuotedReposts.map(q => q.id));
      const replies = allReplies.filter(r => !quotedRepostIds.has(r.id));

      if (replies.length === 0 && filteredQuotedReposts.length === 0) {
        repliesContainer.innerHTML = `
          <div class="snv-replies__empty">
            <p>No replies or quotes yet</p>
          </div>
        `;
        return;
      }

      const threadTree = this.buildThreadTree(replies, this.config.noteId);
      const totalComments = replies.length + filteredQuotedReposts.length;

      this.updateStats(replies.length, filteredQuotedReposts.length);

      repliesContainer.innerHTML = `
        <div class="snv-replies__header">
          <h2 class="h3">Replies & Quotes (${totalComments})</h2>
        </div>
        <div class="snv-replies__list"></div>
      `;

      const repliesList = repliesContainer.querySelector('.snv-replies__list');
      if (!repliesList) return;

      const comments = [
        ...threadTree.map(node => ({ type: 'reply' as const, node, timestamp: node.event.created_at })),
        ...filteredQuotedReposts.map(event => ({ type: 'quote' as const, event, timestamp: event.created_at }))
      ].sort((a, b) => a.timestamp - b.timestamp);

      for (const comment of comments) {
        if (comment.type === 'reply') {
          this.renderThreadedReply(comment.node, repliesList);
        } else {
          await this.renderQuotedRepost(comment.event, repliesList);
        }
      }
    } catch (error) {
      this.systemLogger.error('ThreadManager', `Failed to load replies: ${error}`);
      repliesContainer.innerHTML = `
        <div class="snv-replies__error">
          <p>Failed to load replies</p>
        </div>
      `;
    }
  }

  private buildThreadTree(replies: NostrEvent[], rootNoteId: string): ThreadNode[] {
    const nodes = new Map<string, ThreadNode>();
    const rootNodes: ThreadNode[] = [];

    replies.forEach(reply => {
      const replyId = reply.id;
      if (!replyId) return;
      nodes.set(replyId, { event: reply, children: [], depth: 0 });
    });

    replies.forEach(reply => {
      const replyId = reply.id;
      if (!replyId) return;
      const node = nodes.get(replyId)!;
      const parentId = this.extractReplyParentId(reply);

      if (!parentId || parentId === rootNoteId) {
        rootNodes.push(node);
      } else {
        const parentNode = nodes.get(parentId);
        if (parentNode) {
          node.depth = parentNode.depth + 1;
          parentNode.children.push(node);
        } else {
          rootNodes.push(node);
        }
      }
    });

    return rootNodes;
  }

  private extractReplyParentId(reply: NostrEvent): string | null {
    const eTags = reply.tags.filter(tag => tag[0] === 'e');
    if (eTags.length === 0) return null;

    const replyTag = eTags.find(tag => tag[3] === 'reply');
    if (replyTag) return replyTag[1] ?? null;

    const lastETag = eTags[eTags.length - 1];
    return lastETag?.[1] ?? null;
  }

  private renderThreadedReply(node: ThreadNode, container: Element): void {
    const replyElement = this.createReplyElement(node.event, node.depth);
    container.appendChild(replyElement);

    node.children.forEach(childNode => {
      this.renderThreadedReply(childNode, container);
    });
  }

  private createReplyElement(reply: NostrEvent, depth: number = 0): HTMLElement {
    const isUserLoggedIn = this.authService.getCurrentUser() !== null;

    const noteElement = NoteUI.createNoteElement(reply, {
      collapsible: true,
      islFetchStats: true,
      isLoggedIn: isUserLoggedIn,
      headerSize: 'small',
      depth: 0,
      replyContext: true
    });

    const replyId = reply.id;
    if (replyId) {
      this.config.onLoadZapsList?.(replyId, reply.pubkey, noteElement);
    }

    if (depth > 0) {
      // Cap the visual indentation: 7 levels on desktop, 4 on the phone layout
      // (narrow column). Deeper replies keep their real depth + ↳ context band,
      // they just stop indenting so the thread never runs off the right edge.
      const maxIndentDepth = LayoutService.getInstance().isPhone() ? 4 : 7;
      const cappedDepth = Math.min(depth, maxIndentDepth);
      noteElement.style.marginLeft = `${cappedDepth * 1.5}rem`;
      noteElement.classList.add(`reply-depth-${Math.min(depth, 5)}`);
    }

    return noteElement;
  }

  private async updateStats(replies: number, quotedReposts: number): Promise<void> {
    const isl = NoteUI.getInteractionStatusLine(this.config.noteId);
    if (isl) {
      await isl.waitForInitialFetch();
      isl.updateStats({ replies, quotedReposts });
      this.reactionsApi?.updateCachedStats(this.config.noteId, { replies, quotedReposts });
    }

    this.config.onStatsUpdate?.(replies, quotedReposts);
  }

  private updateStatsAfterLiveReply(): void {
    const isl = NoteUI.getInteractionStatusLine(this.config.noteId);
    const currentStats = isl?.getCurrentStats();
    if (isl && currentStats) {
      const newReplies = currentStats.replies + 1;
      isl.updateStats({ replies: newReplies });
      this.reactionsApi?.updateCachedStats(this.config.noteId, { replies: newReplies });
    }
  }

  public appendLiveReply(reply: NostrEvent): void {
    const replyId = reply.id;
    if (!replyId) return;

    const repliesContainer = this.getRepliesContainer();
    if (!repliesContainer) return;

    if (this.config.container.querySelector(`[data-reply-id="${replyId}"]`)) {
      return;
    }

    let repliesList = this.getRepliesList();

    if (!repliesList) {
      repliesContainer.innerHTML = `
        <div class="snv-replies__header">
          <h2 class="h3">Replies & Quotes (1)</h2>
        </div>
        <div class="snv-replies__list"></div>
      `;
      repliesList = repliesContainer.querySelector('.snv-replies__list');
    } else {
      const header = repliesContainer.querySelector('.snv-replies__header h2');
      if (header) {
        const match = header.textContent?.match(/\((\d+)\)/);
        const matchedCount = match?.[1];
        if (matchedCount) {
          const currentCount = parseInt(matchedCount, 10);
          header.textContent = `Replies & Quotes (${currentCount + 1})`;
        }
      }
    }

    if (!repliesList) return;

    const replyElement = this.createReplyElement(reply, 0);
    replyElement.classList.add('reply-pending');
    replyElement.dataset.replyId = replyId;

    repliesList.appendChild(replyElement);
    this.updateStatsAfterLiveReply();
  }

  public confirmReply(replyId: string): void {
    const replyElement = this.getRepliesList()?.querySelector(`[data-reply-id="${replyId}"]`);
    if (replyElement) {
      replyElement.classList.remove('reply-pending');
      replyElement.classList.add('reply-confirmed');
    }
  }

  private async renderQuotedRepost(quoteEvent: NostrEvent, container: Element): Promise<void> {
    const eventId = quoteEvent.id;
    if (!eventId) return;

    const cleanedEvent = {
      ...quoteEvent,
      content: quoteEvent.content.replace(/nostr:(nevent|note|nprofile|npub)[a-z0-9]+/gi, '').trim()
    };

    const quoteWrapper = document.createElement('div');
    quoteWrapper.className = 'snv-quoted-repost';
    quoteWrapper.dataset.eventId = eventId;

    const profile = await this.profileService.getUserProfile(quoteEvent.pubkey);
    const username = profile?.display_name || profile?.name || 'Anonymous';

    const nevent = encodeNevent(eventId, [], quoteEvent.pubkey);

    const quoteHeader = document.createElement('div');
    quoteHeader.className = 'snv-quoted-repost__header';
    quoteHeader.innerHTML = `<a href="/note/${nevent}" class="snv-quoted-repost__link"><svg class="snv-quoted-repost__icon" width="14" height="14"><use href="#icon-repost"/></svg><span><strong>${escapeHtml(username)}</strong> quoted this in a repost · open original →</span></a>`;

    const link = quoteHeader.querySelector('.snv-quoted-repost__link') as HTMLAnchorElement;
    link?.addEventListener('click', (e) => {
      e.preventDefault();
      Router.getInstance().navigate(`/note/${nevent}`);
    });

    const noteElement = NoteUI.createNoteElement(cleanedEvent, {
      collapsible: false,
      islFetchStats: false,
      isLoggedIn: false,
      headerSize: 'small',
      depth: 0
    });

    quoteWrapper.appendChild(quoteHeader);
    quoteWrapper.appendChild(noteElement);
    container.appendChild(quoteWrapper);
  }
}
