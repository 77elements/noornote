/**
 * RepliesRenderer Component
 * Handles fetching and rendering replies for notes and articles
 * Shared component used by SingleNoteView and ArticleView
 */

import { NoteUI } from '../ui/NoteUI';
import { LazyModuleApi } from '../../core/LazyModuleApi';
import type { SingleNoteModuleApi } from '../../modules/single-note/contracts';
import type { ReactionsModuleApi } from '../../modules/reactions/contracts';
import { UserProfileService } from '../../services/UserProfileService';
import { AuthService } from '../../services/AuthService';
import {
  fetchQuotedRepostCandidates,
  mergeChronologicalComments,
  pinAuthorReplies,
  isAuthorTopLevelReply,
  renderQuotedNoteCard,
  renderThreadedReplyNodes,
} from '../../helpers/quotedReposts';
import { buildThreadTree as buildSharedThreadTree } from '../../helpers/threadTree';
import { RelayConfig } from '../../services/RelayConfig';
import { SystemLogger } from '../../services/SystemLogger';
import { escapeHtml } from '../../helpers/escapeHtml';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { _ } from '../../i18n';

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

  private singleNoteApi = new LazyModuleApi<SingleNoteModuleApi>('single-note');
  private reactionsApi = new LazyModuleApi<ReactionsModuleApi>('reactions');
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
        <p>${_('Loading replies...')}</p>
      </div>
    `;

    try {
      // Fetch both replies and quoted reposts in parallel
      const [allReplies, allQuotedReposts] = await Promise.all([
        this.singleNoteApi.get()?.fetchReplies(this.noteId) ??
          Promise.resolve([]),
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
            <p>${_('No replies or quotes yet')}</p>
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
          this.reactionsApi.get()?.updateCachedStats(this.noteId, {
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
        // Mix TOP-LEVEL replies and quoted reposts, sorted by timestamp, with
        // the note author's direct replies pinned to the top (Twitter-style:
        // corrections must not drown in the reply flood).
        const comments = pinAuthorReplies(
          mergeChronologicalComments(threadTree, quotedReposts),
          this.noteAuthor
        );

        // Render all comments
        for (const comment of comments) {
          if (comment.type === 'reply') {
            // isAuthorPin applies ONLY to the pinned node itself (depth 0) —
            // replies below it must NOT inherit the (Author) badge.
            renderThreadedReplyNodes(
              comment.node,
              repliesList,
              (event, depth) =>
                this.createReplyElement(
                  event,
                  depth,
                  isAuthorTopLevelReply(comment, this.noteAuthor) && depth === 0
                )
            );
          } else {
            await this.renderQuotedRepost(comment.event, repliesList);
          }
        }
      }
    } catch (error) {
      console.error('Failed to load replies:', error);
      this.container.innerHTML = `
        <div class="snv-replies__error">
          <p>${_('Failed to load replies. Please try again.')}</p>
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
   * Create a reply element with depth-based indentation
   */
  private createReplyElement(
    reply: NostrEvent,
    depth: number = 0,
    isAuthorPin: boolean = false
  ): HTMLElement {
    const isUserLoggedIn = AuthService.getInstance().getCurrentUser() !== null;

    const noteElement = NoteUI.createNoteElement(reply, {
      collapsible: true,
      islFetchStats: true,
      isLoggedIn: isUserLoggedIn,
      headerSize: 'small',
      depth: 0,
    });

    // Author pin badge (Twitter-style): clarifies why this reply sits above
    // the chronological flow. Inline, right after the username in the header.
    if (isAuthorPin) {
      const usernameEl = noteElement.querySelector('.user-identity__username');
      if (usernameEl) {
        const badge = document.createElement('span');
        badge.className = 'badge snv-reply__author-badge';
        badge.textContent = _('(Author)');
        usernameEl.after(badge);
      }
    }

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

    const noteElement = await renderQuotedNoteCard({
      quoteEvent,
      container,
      // Strip the embedded event/note/naddr references from content (the
      // quoted target is already indicated by the header below and would
      // render redundantly as an inline preview card otherwise).
      // Keep nostr:npub / nostr:nprofile mentions — those are user mentions,
      // distinct from the quoted target, and useful UX.
      stripPattern: /nostr:(nevent|note|naddr)[a-z0-9]+/gi,
      // "X quoted this note:" header — entire line is one clickable link
      headerHtml: (username, nevent) =>
        `<a href="/note/${nevent}" class="snv-quoted-repost__link"><strong>${escapeHtml(username)}</strong> quoted this note:</a>`,
      getUsername: async pubkey => {
        const profile =
          await UserProfileService.getInstance().getUserProfile(pubkey);
        return profile?.display_name || profile?.name || null;
      },
    });
    if (!noteElement) return;

    // Setup CollapsibleManager AFTER element is in DOM
    const { CollapsibleManager } = await import(
      '../ui/note-features/CollapsibleManager'
    );
    CollapsibleManager.setup(noteElement, { maxHeight: '40vh' });
  }
}
