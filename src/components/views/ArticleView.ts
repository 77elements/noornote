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
import { AnalyticsModal } from '../analytics/AnalyticsModal';
import { getAddressableIdentifier } from '../../helpers/getAddressableIdentifier';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { marked } from 'marked';

export class ArticleView {
  private container: HTMLElement;
  private naddrRef: string;
  private orchestrator: LongFormOrchestrator;
  private reactionsOrchestrator: ReactionsOrchestrator;

  constructor(naddrRef: string) {
    this.naddrRef = naddrRef;
    this.container = document.createElement('div');
    this.container.className = 'article-view-container';
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

      if (!event) {
        this.showError('Article not found');
        return;
      }

      this.renderArticle(event);
    } catch (_error) {
      console.error('❌ ArticleView: Failed to load article', _error);
      this.showError('Failed to load article');
    }
  }

  /**
   * Render the loaded article
   */
  private renderArticle(event: NostrEvent): void {
    const metadata = LongFormOrchestrator.extractArticleMetadata(event);

    // Create article structure with replies container
    this.container.innerHTML = `
      <div class="article-view-content">
        <div class="article-header">
          ${metadata.image ? `<img src="${metadata.image}" alt="${this.escapeHtml(metadata.title)}" class="article-banner" />` : ''}
          <h1 class="article-title">${this.escapeHtml(metadata.title)}</h1>
          ${metadata.summary ? `<p class="article-summary">${this.escapeHtml(metadata.summary)}</p>` : ''}
          <div class="article-author-container"></div>
        </div>
        <div class="article-body">${this.renderMarkdown(event.content)}</div>
        <div class="article-replies-container"></div>
      </div>
    `;

    // Mount author header
    const authorContainer = this.container.querySelector('.article-author-container');
    if (authorContainer) {
      const noteHeader = new NoteHeader({
        pubkey: event.pubkey,
        eventId: event.id,
        timestamp: metadata.publishedAt,
        rawEvent: event,
        size: 'medium',
        showVerification: true,
        showTimestamp: true,
        showMenu: true
      });
      authorContainer.appendChild(noteHeader.getElement());
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
   */
  private renderMarkdown(content: string): string {
    try {
      // Configure marked for security and link handling
      marked.setOptions({
        breaks: true,        // Convert \n to <br>
        gfm: true,          // GitHub Flavored Markdown
        headerIds: false,   // Don't add IDs to headers (security)
        mangle: false       // Don't mangle email addresses
      });

      // Parse markdown to HTML
      const html = marked.parse(content) as string;

      // Add rel for security - global handler in App.ts opens external links
      return html.replace(/<a href=/g, '<a rel="noopener noreferrer" href=');
    } catch (_error) {
      console.error('Failed to render markdown:', _error);
      // Fallback: return escaped plain text
      return `<p>${this.escapeHtml(content)}</p>`;
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
   * Escape HTML to prevent XSS
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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
