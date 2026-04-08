/**
 * ArticleView Component
 * Displays long-form article (NIP-23, kind 30023) with full content
 * Similar to SingleNoteView but for addressable events
 */

import { NoteHeader } from '../ui/NoteHeader';
import { InteractionStatusLine } from '../ui/InteractionStatusLine';
import { RepliesRenderer } from '../replies/RepliesRenderer';
import { ZapsList } from '../ui/ZapsList';
import { LikesList } from '../ui/LikesList';
import { LongFormOrchestrator } from '../../services/orchestration/LongFormOrchestrator';
import { ReactionsOrchestrator } from '../../services/orchestration/ReactionsOrchestrator';
import { AuthService } from '../../services/AuthService';
import { Router } from '../../services/Router';
import { encodeNaddr } from '../../services/NostrToolsAdapter';
import { AnalyticsModal } from '../analytics/AnalyticsModal';
import { getAddressableIdentifier } from '../../helpers/getAddressableIdentifier';
import { npubToUsername } from '../../helpers/npubToUsername';
import { extractQuotedReferences } from '../../helpers/extractQuotedReferences';
import { formatQuotedReferences, type QuotedReference } from '../../helpers/formatQuotedReferences';
import { ContentProcessor } from '../../services/ContentProcessor';
import { QuotedNoteRenderer } from '../../services/QuotedNoteRenderer';
import { ArticlePreviewRenderer } from '../../services/ArticlePreviewRenderer';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { escapeHtml } from '../../helpers/escapeHtml';

export class ArticleView {
  private container: HTMLElement;
  private naddrRef: string;
  private orchestrator: LongFormOrchestrator;
  private reactionsOrchestrator: ReactionsOrchestrator;

  constructor(naddrRef: string) {
    this.naddrRef = naddrRef;
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--article';
    this.orchestrator = LongFormOrchestrator.getInstance();
    this.reactionsOrchestrator = ReactionsOrchestrator.getInstance();

    this.render();
  }

  /**
   * Initial render - show loading, then load article
   */
  private async render(): Promise<void> {
    // Show loading state
    this.container.innerHTML = `
      <div class="article-view-loading">
        <div class="loading-spinner"></div>
        <p>Loading article...</p>
      </div>
    `;

    try {
      // Fetch the article
      const event = await this.orchestrator.fetchAddressableEvent(this.naddrRef);

      if (!event || !event.id) {
        this.showError('Article not found');
        return;
      }

      this.renderArticle(event as NostrEvent & { id: string });
    } catch (_error) {
      console.error('❌ ArticleView: Failed to load article', _error);
      this.showError('Failed to load article');
    }
  }

  /**
   * Render the loaded article
   */
  private renderArticle(event: NostrEvent & { id: string }): void {
    const metadata = LongFormOrchestrator.extractArticleMetadata(event);

    // Check if current user is the author
    const isOwnArticle = AuthService.getInstance().isCurrentUser(event.pubkey);

    // Render markdown and extract quoted references
    const { html: articleHtml, quotedReferences } = this.renderMarkdown(event.content);

    // Create article structure with replies container
    this.container.innerHTML = `
      <div class="article-view-content">
        <div class="article-header">
          ${metadata.image ? `<img src="${metadata.image}" alt="${escapeHtml(metadata.title)}" class="article-banner" />` : ''}
          <div class="article-title-row">
            <h1 class="article-title">${escapeHtml(metadata.title)}</h1>
            ${isOwnArticle ? `
              <div class="article-title-row__actions">
                <button class="btn btn--medium btn--passive" data-action="edit-article" title="Edit article">
                  <svg width="14" height="14"><use href="#icon-edit"/></svg>
                  Edit
                </button>
                <button class="btn btn--medium btn--danger" data-action="delete-article" title="Delete article">Delete</button>
              </div>
            ` : ''}
          </div>
          ${metadata.summary ? `<p class="article-summary">${escapeHtml(metadata.summary)}</p>` : ''}
          <div class="article-author-container"></div>
        </div>
        <div class="article-body">${articleHtml}</div>
        <div class="article-replies-container"></div>
      </div>
    `;

    // Replace quote markers with actual quote boxes (same logic as OriginalNoteRenderer)
    if (quotedReferences.length > 0) {
      const quotedNoteRenderer = QuotedNoteRenderer.getInstance();
      const articleRenderer = ArticlePreviewRenderer.getInstance();

      quotedReferences.forEach(ref => {
        const marker = this.container.querySelector(`.quote-marker[data-quote-ref="${ref.fullMatch}"]`);
        if (marker) {
          if (ref.type === 'addr') {
            articleRenderer.renderArticlePreview(ref.fullMatch, marker.parentElement!);
            marker.remove();
          } else {
            const skeleton = quotedNoteRenderer.createQuoteSkeleton();
            marker.replaceWith(skeleton);
            quotedNoteRenderer.fetchAndRenderQuote(ref, skeleton, false);
          }
        }
      });
    }

    // Mount author header
    const authorContainer = this.container.querySelector('.article-author-container');
    if (authorContainer) {
      const noteHeader = new NoteHeader({
        pubkey: event.pubkey,
        eventId: event.id,
        timestamp: metadata.publishedAt,
        rawEvent: event,
        showVerification: true,
        showTimestamp: true,
        showMenu: true
      });
      authorContainer.appendChild(noteHeader.getElement());

      // If the author set a `published_at` tag that differs from the event's
      // `created_at` (typical for backdated imports or post-publish edits),
      // show published_at prominently (via NoteHeader above) and put the
      // raw created_at in parentheses directly below.
      if (metadata.publishedAt !== event.created_at) {
        const editedMeta = document.createElement('div');
        editedMeta.className = 'article-header__edited-meta';
        const createdDate = new Date(event.created_at * 1000).toLocaleDateString(undefined, {
          year: 'numeric', month: 'long', day: 'numeric'
        });
        editedMeta.textContent = `(last edited ${createdDate})`;
        authorContainer.appendChild(editedMeta);
      }
    }

    // Edit & delete button click handlers
    if (isOwnArticle) {
      const editBtn = this.container.querySelector('[data-action="edit-article"]');
      editBtn?.addEventListener('click', () => {
        const naddr = encodeNaddr({
          kind: 30023,
          pubkey: event.pubkey,
          identifier: metadata.identifier,
          relays: []
        });
        Router.getInstance().navigate(`/edit-article/${naddr}`);
      });

      const deleteBtn = this.container.querySelector('[data-action="delete-article"]');
      deleteBtn?.addEventListener('click', async () => {
        const { ModalService } = await import('../../services/ModalService');
        const confirmed = await ModalService.getInstance().confirm({
          title: 'Delete Article',
          message: 'This will send a deletion request to all relays. This cannot be undone.',
          confirmText: 'Delete',
          cancelText: 'Cancel',
          confirmDestructive: true,
        });

        if (!confirmed) return;

        const { DeletionService } = await import('../../services/DeletionService');
        const coordinate = `30023:${event.pubkey}:${metadata.identifier}`;
        const deleted = await DeletionService.getInstance().deleteByCoordinates([coordinate]);

        if (deleted) {
          Router.getInstance().back();
        }
      });
    }

    // For addressable events (kind 30023), use addressable identifier instead of event ID
    const addressableId = getAddressableIdentifier(event);
    const noteId = addressableId || event.id; // Fallback to event.id if extraction fails

    // LONG-FORM ARTICLE: Store event.id to search both #a and #e tags for interactions
    const articleEventId = event.id;

    // Mount ISL directly after article-body
    const articleBody = this.container.querySelector('.article-body');
    if (articleBody) {
      const isl = new InteractionStatusLine({
        noteId,
        authorPubkey: event.pubkey,
        originalEvent: event, // Pass original event for reposting
        fetchStats: true,
        isLoggedIn: true,
        articleEventId, // LONG-FORM ARTICLE: Pass event ID for proper zap tagging
        onAnalytics: () => {
          const analyticsModal = AnalyticsModal.getInstance();
          analyticsModal.show(noteId, event);
        }
      });
      articleBody.insertAdjacentElement('afterend', isl.getElement());

      // Load zaps and likes list (pass articleEventId for long-form article dual-tag search)
      this.loadZapsList(noteId, event.pubkey, articleBody.parentElement as HTMLElement, articleEventId);
    }

    // Load and render replies (pass articleEventId for long-form article dual-tag search)
    this.loadReplies(noteId, event.pubkey, articleEventId);
  }

  /**
   * Load and render zaps/likes lists above ISL
   * @param noteId - Addressable identifier (kind:pubkey:d-tag)
   * @param authorPubkey - Author's pubkey
   * @param articleContainer - Container element
   * @param articleEventId - Event ID for long-form articles (to search both #a and #e tags)
   */
  private async loadZapsList(noteId: string, authorPubkey: string, articleContainer: HTMLElement, articleEventId?: string): Promise<void> {
    try {
      // LONG-FORM ARTICLE: Pass eventId to search both #a and #e tags
      const stats = await this.reactionsOrchestrator.getDetailedStats(noteId, articleEventId);

      // Find ISL container
      const islContainer = articleContainer.querySelector('.isl');
      if (!islContainer || !islContainer.parentNode) return;

      // Remove existing lists if present
      const existingZapsList = articleContainer.querySelector('.zaps-list');
      const existingLikesList = articleContainer.querySelector('.likes-list');
      if (existingZapsList) existingZapsList.remove();
      if (existingLikesList) existingLikesList.remove();

      // Render ZapsList if zaps exist
      if (stats.zapEvents.length > 0) {
        const zapsList = new ZapsList(stats.zapEvents);
        islContainer.parentNode.insertBefore(zapsList.getElement(), islContainer);
      }

      // Render LikesList if reactions exist
      if (stats.reactionEvents.length > 0) {
        const likesList = new LikesList(stats.reactionEvents, noteId, authorPubkey);
        await likesList.init();
        islContainer.parentNode.insertBefore(likesList.getElement(), islContainer);
      }
    } catch (_error) {
      console.warn('Failed to load zaps/likes list:', _error);
    }
  }

  /**
   * Load and render replies for the article
   * @param noteId - Addressable identifier (kind:pubkey:d-tag)
   * @param noteAuthor - Author's pubkey
   * @param _articleEventId - Event ID for long-form articles (to search both #a and #e tags)
   */
  private async loadReplies(noteId: string, noteAuthor: string, _articleEventId?: string): Promise<void> {
    const repliesContainer = this.container.querySelector('.article-replies-container');
    if (!repliesContainer) return;

    // Use RepliesRenderer to handle all reply logic
    const repliesRenderer = new RepliesRenderer({
      container: repliesContainer as HTMLElement,
      noteId,
      noteAuthor,
      updateISL: false, // Don't update ISL for articles (addressable identifier mismatch)
      onLoadZapsList: (replyId, replyAuthor, noteElement) => {
        // Replies are normal notes (not addressable), no articleEventId needed
        this.loadZapsListForReply(replyId, replyAuthor, noteElement);
      }
    });

    await repliesRenderer.loadAndRender();
  }

  /**
   * Load zaps list for a reply (normal note, not addressable)
   */
  private async loadZapsListForReply(noteId: string, authorPubkey: string, noteElement: HTMLElement): Promise<void> {
    try {
      // Replies are normal notes - no articleEventId needed
      const stats = await this.reactionsOrchestrator.getDetailedStats(noteId);

      const islContainer = noteElement.querySelector('.isl');
      if (!islContainer || !islContainer.parentNode) return;

      // Remove existing lists
      const existingZapsList = noteElement.querySelector('.zaps-list');
      const existingLikesList = noteElement.querySelector('.likes-list');
      if (existingZapsList) existingZapsList.remove();
      if (existingLikesList) existingLikesList.remove();

      // Render ZapsList
      if (stats.zapEvents.length > 0) {
        const zapsList = new ZapsList(stats.zapEvents);
        islContainer.parentNode.insertBefore(zapsList.getElement(), islContainer);
      }

      // Render LikesList
      if (stats.reactionEvents.length > 0) {
        const likesList = new LikesList(stats.reactionEvents, noteId, authorPubkey);
        await likesList.init();
        islContainer.parentNode.insertBefore(likesList.getElement(), islContainer);
      }
    } catch (_error) {
      console.warn('Failed to load zaps/likes list for reply:', _error);
    }
  }

  /**
   * Render markdown content using marked.js (NIP-23 support)
   * Also extracts and formats nostr: quoted references (NIP-27)
   */
  private renderMarkdown(content: string): { html: string; quotedReferences: QuotedReference[] } {
    try {
      // Configure marked for security and link handling
      marked.setOptions({
        breaks: true,        // Convert \n to <br>
        gfm: true           // GitHub Flavored Markdown
      });

      // Extract quoted references from raw content before markdown parsing
      const quotedReferences = extractQuotedReferences(content) as QuotedReference[];

      // Parse markdown to HTML, then sanitize to prevent XSS
      let html = DOMPurify.sanitize(marked.parse(content) as string, {
        ALLOWED_TAGS: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'ul', 'ol', 'li',
          'strong', 'em', 'b', 'i', 'u', 's', 'del', 'code', 'pre', 'blockquote',
          'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'sup', 'sub', 'span', 'div'],
        ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'id', 'target', 'rel', 'loading'],
        ALLOW_DATA_ATTR: false
      });

      // Replace nostr: references with quote marker spans
      if (quotedReferences.length > 0) {
        html = formatQuotedReferences(html, quotedReferences);
      }

      // Add rel for security - global handler in App.ts opens external links
      html = html.replace(/<a href=/g, '<a rel="noopener noreferrer" href=');

      // Convert npub/nprofile mentions to profile links
      const contentProcessor = ContentProcessor.getInstance();
      const profileResolver = (hexPubkey: string) => {
        const profile = contentProcessor.getNonBlockingProfile(hexPubkey);
        return profile ? {
          name: profile.name,
          display_name: profile.display_name,
          picture: profile.picture
        } : null;
      };
      html = npubToUsername(html, 'html-multi', profileResolver, { forceFullMode: true });

      return { html, quotedReferences };
    } catch (_error) {
      console.error('Failed to render markdown:', _error);
      // Fallback: return escaped plain text
      return { html: `<p>${escapeHtml(content)}</p>`, quotedReferences: [] };
    }
  }

  /**
   * Show error state
   */
  private showError(message: string): void {
    this.container.innerHTML = `
      <div class="article-view-error">
        <div class="error-icon">⚠️</div>
        <p>${message}</p>
      </div>
    `;
  }


  /**
   * Get the container element
   */
  public getElement(): HTMLElement {
    return this.container;
  }

  /**
   * Cleanup when view is destroyed
   */
  public destroy(): void {
    this.container.innerHTML = '';
  }
}
