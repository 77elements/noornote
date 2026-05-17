/**
 * RepliesRenderer Component
 * Handles fetching and rendering replies for notes and articles
 * Shared component used by SingleNoteView and ArticleView
 */

import { NoteUI } from '../ui/NoteUI';
import { ThreadOrchestrator } from '../../services/orchestration/ThreadOrchestrator';
import { ReactionsOrchestrator } from '../../services/orchestration/ReactionsOrchestrator';
import { UserProfileService } from '../../services/UserProfileService';
import { AuthService } from '../../services/AuthService';
import { fetchNostrEvents } from '../../helpers/fetchNostrEvents';
import { RelayConfig } from '../../services/RelayConfig';
import { SystemLogger } from '../system/SystemLogger';
import { encodeNevent } from '../../services/NostrToolsAdapter';
import { escapeHtml } from '../../helpers/escapeHtml';
import { Router } from '../../services/Router';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

/** Thread node for building reply tree */
interface ThreadNode {
  event: NostrEvent;
  children: ThreadNode[];
  depth: number;
}

export interface RepliesRendererOptions {
  /** Container element to render replies into */
  container: HTMLElement;
  /** Note ID or addressable identifier (for addressable events) */
  noteId: string;
  /** Author pubkey of the note/article */
  noteAuthor: string;
  /** Whether to update ISL stats after fetching replies */
  updateISL?: boolean;
  /** Callback to load zaps list for a reply */
  onLoadZapsList?: (noteId: string, authorPubkey: string, noteElement: HTMLElement) => void;
}

export class RepliesRenderer {
  private container: HTMLElement;
  private noteId: string;
  private noteAuthor: string;
  private updateISL: boolean;
  private onLoadZapsList?: (noteId: string, authorPubkey: string, noteElement: HTMLElement) => void;

  private threadOrchestrator: ThreadOrchestrator;
  private reactionsOrchestrator: ReactionsOrchestrator;
  private relayConfig: RelayConfig;
  private systemLogger: SystemLogger;

  constructor(options: RepliesRendererOptions) {
    this.container = options.container;
    this.noteId = options.noteId;
    this.noteAuthor = options.noteAuthor;
    this.updateISL = options.updateISL !== false; // Default true
    if (options.onLoadZapsList) this.onLoadZapsList = options.onLoadZapsList;

    this.threadOrchestrator = ThreadOrchestrator.getInstance();
    this.reactionsOrchestrator = ReactionsOrchestrator.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.systemLogger = SystemLogger.getInstance();
  }

  /**
   * Load and render replies for a note/article
   */
  public async loadAndRender(): Promise<void> {
    // Show loading state
    this.container.innerHTML = `
      <div class="snv-replies__loading">
        <div class="loading-spinner"></div>
        <p>Loading replies...</p>
      </div>
    `;

    try {
      // Fetch both replies and quoted reposts in parallel
      const [allReplies, allQuotedReposts] = await Promise.all([
        this.threadOrchestrator.fetchReplies(this.noteId),
        this.fetchQuotedReposts(this.noteId)
      ]);

      // Filter out quoted reposts from the same author (own replies with quotes)
      const fetchedQuotedReposts = allQuotedReposts.filter(q => q.pubkey !== this.noteAuthor);

      // Filter out any "replies" that are also quoted reposts (to avoid duplicates)
      const fetchedQuoteIds = new Set(fetchedQuotedReposts.map(q => q.id));
      const repliesAndUnmarkedQuotes = allReplies.filter(r => !fetchedQuoteIds.has(r.id));

      // Reclassify kind:1 events whose addressable parent reference is bare
      // (no reply/root marker) as quoted reposts. Bare 'a' tags on kind:1
      // typically come from NIP-18 quote-posts where the article is referenced
      // for indexing/tagging purposes only, not as a reply target. Real replies
      // carry an explicit "reply" or "root" marker.
      const isUnmarkedQuotePost = (e: NostrEvent): boolean => {
        if (e.kind !== 1) return false;
        const aTags = e.tags.filter(t => t[0] === 'a');
        if (aTags.length === 0) return false;
        if (aTags.some(t => t[3] === 'reply' || t[3] === 'root')) return false;
        return true;
      };
      const replies: NostrEvent[] = [];
      const reclassifiedQuotes: NostrEvent[] = [];
      for (const r of repliesAndUnmarkedQuotes) {
        if (isUnmarkedQuotePost(r)) reclassifiedQuotes.push(r);
        else replies.push(r);
      }
      const quotedReposts = [...fetchedQuotedReposts, ...reclassifiedQuotes];
      // Note: Muted users already filtered in ThreadOrchestrator.fetchReplies()

      if (replies.length === 0 && quotedReposts.length === 0) {
        this.container.innerHTML = `
          <div class="snv-replies__empty">
            <p>No replies or quotes yet</p>
          </div>
        `;
        return;
      }

      // Build thread tree from replies
      const threadTree = this.buildThreadTree(replies, this.noteId);

      // Count total comments (replies + quoted reposts, not nested)
      const totalComments = replies.length + quotedReposts.length;

      // Update ISL reply count in main note (if requested)
      if (this.updateISL) {
        const isl = NoteUI.getInteractionStatusLine(this.noteId);
        if (isl) {
          await isl.waitForInitialFetch();
          isl.updateStats({
            replies: replies.length,
            quotedReposts: quotedReposts.length
          });

          // Also update the cache so Timeline shows correct count
          this.reactionsOrchestrator.updateCachedStats(this.noteId, {
            replies: replies.length,
            quotedReposts: quotedReposts.length
          });
        }
      }

      // Render header with total comment count
      this.container.innerHTML = `
        <div class="snv-replies__header">
          <h2 class="h3">Replies & Quotes (${totalComments})</h2>
        </div>
        <div class="snv-replies__list"></div>
      `;

      const repliesList = this.container.querySelector('.snv-replies__list');
      if (repliesList) {
        // Mix TOP-LEVEL replies and quoted reposts, sorted by timestamp
        const comments = [
          ...threadTree.map(node => ({
            type: 'reply' as const,
            node: node,
            timestamp: node.event.created_at
          })),
          ...quotedReposts.map(event => ({
            type: 'quote' as const,
            event: event,
            timestamp: event.created_at
          }))
        ].sort((a, b) => a.timestamp - b.timestamp); // Oldest first (chronological)

        // Render all comments
        for (const comment of comments) {
          if (comment.type === 'reply') {
            this.renderThreadedReply(comment.node, repliesList);
          } else {
            await this.renderQuotedRepost(comment.event, repliesList);
          }
        }
      }
    } catch (error) {
      console.error('Failed to load replies:', error);
      this.container.innerHTML = `
        <div class="snv-replies__error">
          <p>Failed to load replies. Please try again.</p>
        </div>
      `;
    }
  }

  /**
   * Build thread tree from flat reply list
   */
  private buildThreadTree(replies: NostrEvent[], rootNoteId: string): ThreadNode[] {
    const nodes = new Map<string, ThreadNode>();
    const rootNodes: ThreadNode[] = [];

    // Create nodes for all replies
    replies.forEach(reply => {
      const replyId = reply.id;
      if (!replyId) return;
      nodes.set(replyId, {
        event: reply,
        children: [],
        depth: 0
      });
    });

    // Build parent-child relationships
    replies.forEach(reply => {
      const replyId = reply.id;
      if (!replyId) return;
      const node = nodes.get(replyId)!;
      const parentId = this.extractReplyParentId(reply);

      if (!parentId || parentId === rootNoteId) {
        // Top-level reply (directly replying to the main note)
        rootNodes.push(node);
      } else {
        // Child reply (replying to another reply)
        const parentNode = nodes.get(parentId);
        if (parentNode) {
          node.depth = parentNode.depth + 1;
          parentNode.children.push(node);
        } else {
          // Parent not found in replies, treat as root-level
          rootNodes.push(node);
        }
      }
    });

    return rootNodes;
  }

  /**
   * Fetch quoted reposts (kind 1 or kind 6 with 'q' tag referencing this note)
   */
  private async fetchQuotedReposts(noteId: string): Promise<NostrEvent[]> {
    const relays = this.relayConfig.getReadRelays();

    this.systemLogger.info('RepliesRenderer', `🔍 Fetching quoted reposts for ${noteId.slice(0, 8)}...`);

    try {
      // Two relay queries in parallel: NIP-18 q-tag AND legacy e-tag-with-mention
      // (Primal-iOS pre-NIP-18 pattern). Tag-OR can't be expressed in one filter.
      const [qTagResult, eTagResult] = await Promise.all([
        fetchNostrEvents({ relays, kinds: [1, 6], tags: { 'q': [noteId] }, limit: 100 }),
        fetchNostrEvents({ relays, kinds: [1], tags: { 'e': [noteId] }, limit: 100 })
      ]);

      const byId = new Map<string, NostrEvent>();
      for (const ev of [...qTagResult.events, ...eTagResult.events]) {
        if (ev.id) byId.set(ev.id, ev);
      }

      const quotedReposts = Array.from(byId.values()).filter(event => {
        const hasContent = event.content.trim().length > 0;
        if (!hasContent) return false;

        const qTags = event.tags.filter(tag => tag[0] === 'q');
        if (qTags.some(tag => tag[1] === noteId)) return true;

        const eTags = event.tags.filter(tag => tag[0] === 'e' && tag[1] === noteId);
        return eTags.some(tag => tag[3] === 'mention')
          && /nostr:(nevent1|note1|naddr1)/.test(event.content);
      });

      this.systemLogger.info('RepliesRenderer', `✅ Quoted reposts: ${quotedReposts.length}`);
      return quotedReposts;
    } catch (error) {
      this.systemLogger.error('RepliesRenderer', `Failed to fetch quoted reposts: ${error}`);
      return [];
    }
  }

  /**
   * Extract parent ID from reply's tags (NIP-10 for kind:1, NIP-22 for kind:1111)
   */
  private extractReplyParentId(reply: NostrEvent): string | null {
    // NIP-22: kind:1111 uses lowercase 'e' tag for parent reference
    if (reply.kind === 1111) {
      const parentETag = reply.tags.find(t => t[0] === 'e');
      return parentETag?.[1] ?? null;
    }

    // NIP-10: kind:1 uses e-tags with markers
    const eTags = reply.tags.filter(tag => tag[0] === 'e');
    if (eTags.length === 0) return null;

    // NIP-10: Look for explicit "reply" marker
    const replyTag = eTags.find(tag => tag[3] === 'reply');
    if (replyTag?.[1]) return replyTag[1];

    // NIP-10 deprecated: last e-tag is the replied-to note
    const lastTag = eTags[eTags.length - 1];
    return lastTag?.[1] ?? null;
  }

  /**
   * Render a threaded reply recursively with indentation
   */
  private renderThreadedReply(node: ThreadNode, container: Element): void {
    const replyElement = this.createReplyElement(node.event, node.depth);
    container.appendChild(replyElement);

    // Recursively render children
    node.children.forEach(childNode => {
      this.renderThreadedReply(childNode, container);
    });
  }

  /**
   * Create a reply element with depth-based indentation
   */
  private createReplyElement(reply: NostrEvent, depth: number = 0): HTMLElement {
    const isUserLoggedIn = AuthService.getInstance().getCurrentUser() !== null;

    const noteElement = NoteUI.createNoteElement(reply, {
      collapsible: true,
      islFetchStats: true,
      isLoggedIn: isUserLoggedIn,
      headerSize: 'small',
      depth: 0
    });

    // Load zaps list for this reply (if callback provided)
    const replyId = reply.id;
    if (this.onLoadZapsList && replyId) {
      this.onLoadZapsList(replyId, reply.pubkey, noteElement);
    }

    // Wrap in reply container with depth-based indentation
    const replyWrapper = document.createElement('div');
    replyWrapper.className = 'snv-reply';
    if (replyId) replyWrapper.dataset.eventId = replyId;
    replyWrapper.dataset.depth = String(Math.min(depth, 7));
    replyWrapper.appendChild(noteElement);

    return replyWrapper;
  }

  /**
   * Render a quoted repost as a special comment
   */
  private async renderQuotedRepost(quoteEvent: NostrEvent, container: Element): Promise<void> {
    const quoteEventId = quoteEvent.id;
    if (!quoteEventId) return;

    this.systemLogger.info('RepliesRenderer', `🎨 Rendering quoted repost: ${quoteEventId.slice(0, 8)}`);

    // Strip the embedded event/note/naddr references from content (the
    // quoted target is already indicated by the "X quoted this note:" header
    // and would render redundantly as an inline preview card otherwise).
    // Keep nostr:npub / nostr:nprofile mentions — those are user mentions,
    // distinct from the quoted target, and useful UX.
    const cleanedEvent = {
      ...quoteEvent,
      content: quoteEvent.content.replace(/nostr:(nevent|note|naddr)[a-z0-9]+/gi, '').trim()
    };

    // Create wrapper for quote
    const quoteWrapper = document.createElement('div');
    quoteWrapper.className = 'snv-quoted-repost';
    quoteWrapper.dataset.eventId = quoteEventId;

    // Fetch author's profile for header
    const profileService = UserProfileService.getInstance();
    const profile = await profileService.getUserProfile(quoteEvent.pubkey);
    const username = profile?.display_name || profile?.name || 'Anonymous';

    // Convert hex ID to nevent for navigation link
    const nevent = encodeNevent(quoteEventId, [], quoteEvent.pubkey);

    // Create "X quoted this note:" header — entire line is one clickable link
    // (matches ThreadManager pattern; uses Router.navigate so SPA routing kicks in)
    const quoteHeader = document.createElement('div');
    quoteHeader.className = 'snv-quoted-repost__header';
    quoteHeader.innerHTML = `<a href="/note/${nevent}" class="snv-quoted-repost__link"><strong>${escapeHtml(username)}</strong> quoted this note:</a>`;
    const link = quoteHeader.querySelector('.snv-quoted-repost__link') as HTMLAnchorElement | null;
    link?.addEventListener('click', (e) => {
      e.preventDefault();
      Router.getInstance().navigate(`/note/${nevent}`);
    });

    // Use NoteUI to render the quote (disable auto-setup)
    const noteElement = NoteUI.createNoteElement(cleanedEvent, {
      collapsible: false,  // Disable auto-setup - will setup manually after DOM insertion
      islFetchStats: false,
      isLoggedIn: false,
      headerSize: 'small',
      depth: 0
    });

    // Assemble: header + note
    quoteWrapper.appendChild(quoteHeader);
    quoteWrapper.appendChild(noteElement);
    container.appendChild(quoteWrapper);

    // Setup CollapsibleManager AFTER element is in DOM
    const { CollapsibleManager } = await import('../ui/note-features/CollapsibleManager');
    CollapsibleManager.setup(noteElement, { maxHeight: '40vh' });
  }
}
