/**
 * RepliesRenderer Component
 * Handles fetching and rendering replies for notes and articles
 * Shared component used by SingleNoteView and ArticleView
 */

import { NoteUI } from '../ui/NoteUI';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { SingleNoteModuleApi } from '../../modules/single-note/contracts';
import type { ReactionsModuleApi } from '../../modules/reactions/contracts';
import { UserProfileService } from '../../services/UserProfileService';
import { AuthService } from '../../services/AuthService';
import {
  fetchQuotedRepostCandidates,
  mergeChronologicalComments,
  renderThreadedReplyNodes,
} from '../../helpers/quotedReposts';
import {
  buildThreadTree as buildSharedThreadTree,
  type ThreadNode,
} from '../../helpers/threadTree';
import { RelayConfig } from '../../services/RelayConfig';
import { SystemLogger } from '../../services/SystemLogger';
import { encodeNevent } from '../../services/NostrToolsAdapter';
import { escapeHtml } from '../../helpers/escapeHtml';
import { Router } from '../../services/Router';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

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
  onLoadZapsList?: (
    noteId: string,
    authorPubkey: string,
    noteElement: HTMLElement
  ) => void;
}

export class RepliesRenderer {
  private container: HTMLElement;
  private noteId: string;
  private noteAuthor: string;
  private updateISL: boolean;
  private onLoadZapsList?: (
    noteId: string,
    authorPubkey: string,
    noteElement: HTMLElement
  ) => void;

  private _singleNoteApi?: SingleNoteModuleApi | null;
  private get singleNoteApi(): SingleNoteModuleApi | null {
    return (this._singleNoteApi ??=
      ModuleLoader.getInstance().getApi<SingleNoteModuleApi>('single-note'));
  }
  private _reactionsApi?: ReactionsModuleApi | null;
  private get reactionsApi(): ReactionsModuleApi | null {
    return (this._reactionsApi ??=
      ModuleLoader.getInstance().getApi<ReactionsModuleApi>('reactions'));
  }
  private relayConfig: RelayConfig;
  private systemLogger: SystemLogger;

  constructor(options: RepliesRendererOptions) {
    this.container = options.container;
    this.noteId = options.noteId;
    this.noteAuthor = options.noteAuthor;
    this.updateISL = options.updateISL !== false; // Default true
    if (options.onLoadZapsList) this.onLoadZapsList = options.onLoadZapsList;

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
        this.singleNoteApi?.fetchReplies(this.noteId) ?? Promise.resolve([]),
        this.fetchQuotedReposts(this.noteId),
      ]);

      // Filter out quoted reposts from the same author (own replies with quotes)
      const fetchedQuotedReposts = allQuotedReposts.filter(
        q => q.pubkey !== this.noteAuthor
      );

      // Filter out any "replies" that are also quoted reposts (to avoid duplicates)
      const fetchedQuoteIds = new Set(fetchedQuotedReposts.map(q => q.id));
      const repliesAndUnmarkedQuotes = allReplies.filter(
        r => !fetchedQuoteIds.has(r.id)
      );

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
      const threadTree = buildSharedThreadTree(replies, this.noteId);

      // Count total comments (replies + quoted reposts, not nested)
      const totalComments = replies.length + quotedReposts.length;

      // Update ISL reply count in main note (if requested)
      if (this.updateISL) {
        const isl = NoteUI.getInteractionStatusLine(this.noteId);
        if (isl) {
          await isl.waitForInitialFetch();
          isl.updateStats({
            replies: replies.length,
            quotedReposts: quotedReposts.length,
          });

          // Also update the cache so Timeline shows correct count
          this.reactionsApi?.updateCachedStats(this.noteId, {
            replies: replies.length,
            quotedReposts: quotedReposts.length,
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
        const comments = mergeChronologicalComments(threadTree, quotedReposts);

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
   * Fetch quoted reposts (kind 1 or kind 6 with 'q' tag referencing this note)
   */
  private async fetchQuotedReposts(noteId: string): Promise<NostrEvent[]> {
    const relays = this.relayConfig.getReadRelays();

    this.systemLogger.info(
      'RepliesRenderer',
      `🔍 Fetching quoted reposts for ${noteId.slice(0, 8)}...`
    );

    try {
      const quotedReposts = await fetchQuotedRepostCandidates(relays, noteId);
      this.systemLogger.info(
        'RepliesRenderer',
        `✅ Quoted reposts: ${quotedReposts.length}`
      );
      return quotedReposts;
    } catch (error) {
      this.systemLogger.error(
        'RepliesRenderer',
        `Failed to fetch quoted reposts: ${String(error)}`
      );
      return [];
    }
  }

  /**
   * Render a threaded reply recursively with indentation
   */
  private renderThreadedReply(node: ThreadNode, container: Element): void {
    renderThreadedReplyNodes(node, container, (event, depth) =>
      this.createReplyElement(event, depth)
    );
  }

  /**
   * Create a reply element with depth-based indentation
   */
  private createReplyElement(
    reply: NostrEvent,
    depth: number = 0
  ): HTMLElement {
    const isUserLoggedIn = AuthService.getInstance().getCurrentUser() !== null;

    const noteElement = NoteUI.createNoteElement(reply, {
      collapsible: true,
      islFetchStats: true,
      isLoggedIn: isUserLoggedIn,
      headerSize: 'small',
      depth: 0,
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
  private async renderQuotedRepost(
    quoteEvent: NostrEvent,
    container: Element
  ): Promise<void> {
    const quoteEventId = quoteEvent.id;
    if (!quoteEventId) return;

    this.systemLogger.info(
      'RepliesRenderer',
      `🎨 Rendering quoted repost: ${quoteEventId.slice(0, 8)}`
    );

    // Strip the embedded event/note/naddr references from content (the
    // quoted target is already indicated by the "X quoted this note:" header
    // and would render redundantly as an inline preview card otherwise).
    // Keep nostr:npub / nostr:nprofile mentions — those are user mentions,
    // distinct from the quoted target, and useful UX.
    const cleanedEvent = {
      ...quoteEvent,
      content: quoteEvent.content
        .replace(/nostr:(nevent|note|naddr)[a-z0-9]+/gi, '')
        .trim(),
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
    const link = quoteHeader.querySelector(
      '.snv-quoted-repost__link'
    ) as HTMLAnchorElement | null;
    link?.addEventListener('click', e => {
      e.preventDefault();
      Router.getInstance().navigate(`/note/${nevent}`);
    });

    // Use NoteUI to render the quote (disable auto-setup)
    const noteElement = NoteUI.createNoteElement(cleanedEvent, {
      collapsible: false, // Disable auto-setup - will setup manually after DOM insertion
      islFetchStats: false,
      isLoggedIn: false,
      headerSize: 'small',
      depth: 0,
    });

    // Assemble: header + note
    quoteWrapper.appendChild(quoteHeader);
    quoteWrapper.appendChild(noteElement);
    container.appendChild(quoteWrapper);

    // Setup CollapsibleManager AFTER element is in DOM
    const { CollapsibleManager } = await import(
      '../ui/note-features/CollapsibleManager'
    );
    CollapsibleManager.setup(noteElement, { maxHeight: '40vh' });
  }
}
