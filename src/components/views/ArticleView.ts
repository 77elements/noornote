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
import { ModuleLoader } from '../../core/ModuleLoader';
import type { ArticlesModuleApi } from '../../modules/articles/contracts';
import type { ReactionsModuleApi } from '../../modules/reactions/contracts';
import { AuthService } from '../../services/AuthService';
import { Router } from '../../services/Router';
import { encodeNaddr } from '../../services/NostrToolsAdapter';
import { AnalyticsModal } from '../analytics/AnalyticsModal';
import { getAddressableIdentifier } from '../../helpers/getAddressableIdentifier';
import { npubToUsername } from '../../helpers/npubToUsername';
import { upgradeInlineMentions, setupUserMentionHandlers } from '../../helpers/UserMentionHelper';
import { upgradeArticleImages } from '../../helpers/upgradeArticleImages';
import { extractQuotedReferences } from '../../helpers/extractQuotedReferences';
import { formatQuotedReferences, type QuotedReference } from '../../helpers/formatQuotedReferences';
import { ContentProcessor } from '../../services/ContentProcessor';
import { QuotedNoteRenderer } from '../ui/note-rendering/QuotedNoteRenderer';
import { ArticlePreviewRenderer } from '../ui/note-rendering/ArticlePreviewRenderer';
import type { PostsModuleApi } from '../../modules/posts/contracts';
import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { marked } from 'marked';
import { sanitizeArticleHtml } from '../../helpers/sanitizeUserHtml';
import { escapeHtml } from '../../helpers/escapeHtml';
import { processFootnotes } from '../../helpers/processFootnotes';
import { unwrapSolitaryParagraph } from '../../helpers/unwrapSolitaryParagraph';

export class ArticleView {
  private container: HTMLElement;
  private naddrRef: string;
  private _articlesApi?: ArticlesModuleApi | null;
  private get articlesApi(): ArticlesModuleApi | null {
    return this._articlesApi ??= ModuleLoader.getInstance().getApi<ArticlesModuleApi>('articles');
  }
  private _reactionsApi?: ReactionsModuleApi | null;
  private get reactionsApi(): ReactionsModuleApi | null {
    return this._reactionsApi ??= ModuleLoader.getInstance().getApi<ReactionsModuleApi>('reactions');
  }

  constructor(naddrRef: string) {
    this.naddrRef = naddrRef;
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--article';

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
      // Ensure the lazy articles module is loaded before fetching. On a full page
      // load straight into /article/<naddr> — e.g. clicked from a public NosPress
      // page carousel — the sync getApi('articles') can still be null and the
      // article would wrongly show "not found". ensure() loads it on demand in any
      // boot context (in-app it is already loaded and resolves instantly).
      const api = await ModuleLoader.getInstance().ensure<ArticlesModuleApi>('articles');
      const event = (await api?.fetchAddressableEvent(this.naddrRef)) ?? null;

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
    const metadata = this.articlesApi?.extractArticleMetadata(event) ?? { title: '', image: '', summary: '', publishedAt: 0, identifier: '', topics: [] };

    // Check if current user is the author
    const isOwnArticle = AuthService.getInstance().isCurrentUser(event.pubkey);

    // Render markdown and extract quoted references
    const { html: articleHtml, quotedReferences } = this.renderMarkdown(event.content);

    // Register the article event so TextSelectionToolbar can resolve it sync
    // (NIP-84 highlights need the source event for a-tag construction).
    ModuleLoader.getInstance().getApi<PostsModuleApi>('posts')?.registerNote(event);

    // Create article structure with replies container
    this.container.innerHTML = `
      <div class="article-view-content" data-event-id="${event.id}">
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

    const articleBodyForMentions = this.container.querySelector<HTMLElement>('.article-body');
    if (articleBodyForMentions) {
      upgradeInlineMentions(articleBodyForMentions);
      setupUserMentionHandlers(articleBodyForMentions);
      upgradeArticleImages(articleBodyForMentions);
    }

    // Replace quote markers with actual quote boxes (same logic as OriginalNoteRenderer)
    if (quotedReferences.length > 0) {
      const quotedNoteRenderer = QuotedNoteRenderer.getInstance();
      const articleRenderer = ArticlePreviewRenderer.getInstance();

      quotedReferences.forEach(ref => {
        const marker = this.container.querySelector(`.quote-marker[data-quote-ref="${ref.fullMatch}"]`);
        if (marker) {
          // Unwrap: if the marker is the sole meaningful child of a <p>,
          // lift it out so block-level quote-boxes aren't nested inside <p>.
          unwrapSolitaryParagraph(marker);
          if (ref.type === 'addr') {
            articleRenderer.renderArticlePreview(ref.fullMatch, marker.parentElement!);
            marker.remove();
          } else {
            const skeleton = quotedNoteRenderer.createQuoteSkeleton();
            marker.replaceWith(skeleton);
            quotedNoteRenderer.fetchAndRenderQuote(ref, skeleton, true);
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
          // Preserve the source kind so drafts (30024) round-trip through
          // the editor — hardcoding 30023 here used to send draft owners
          // to "/edit-article/<naddr-with-kind-30023>", which
          // ArticleEditorView then failed to resolve on relays because
          // no kind:30023 with that identifier exists for that pubkey.
          kind: event.kind!,
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

        const { ModuleLoader } = await import('../../core/ModuleLoader');
        const postsApi = ModuleLoader.getInstance().getApi<import('../../modules/posts/contracts').PostsModuleApi>('posts');
        // Use the source kind so a draft's deletion coordinate addresses
        // 30024:<pubkey>:<d>, not the published 30023 path.
        const coordinate = `${event.kind}:${event.pubkey}:${metadata.identifier}`;
        const deleted = await (postsApi?.deleteByCoordinates([coordinate]) ?? Promise.resolve(false));

        if (deleted) {
          Router.getInstance().back();
        }
      });
    }

    // Footnote jumps: inner <main class="primary-content"> is the scroll container,
    // so browser-default anchor scrolling (which targets the window) does nothing visible.
    // Delegate click on sup.footnote-ref / .footnote-backref and scroll the element into view.
    const articleBodyEl = this.container.querySelector('.article-body');
    if (articleBodyEl) {
      articleBodyEl.addEventListener('click', (e) => {
        const t = e.target as HTMLElement;
        const fnLink = t.closest('sup.footnote-ref a, a.footnote-backref') as HTMLAnchorElement | null;
        if (!fnLink) return;
        const href = fnLink.getAttribute('href');
        if (!href?.startsWith('#')) return;
        const targetId = href.slice(1);
        const target = this.container.querySelector(`#${CSS.escape(targetId)}`);
        if (target) {
          e.preventDefault();
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

      // Load zaps and likes list (pass articleEventId for long-form article dual-tag search,
      // and the full event so emoji-badge reactions can build NIP-25-compliant addressable tags)
      this.loadZapsList(noteId, event.pubkey, articleBody.parentElement as HTMLElement, articleEventId, event);
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
  private async loadZapsList(noteId: string, authorPubkey: string, articleContainer: HTMLElement, articleEventId?: string, articleEvent?: NostrEvent): Promise<void> {
    try {
      // LONG-FORM ARTICLE: Pass eventId to search both #a and #e tags
      const stats = await this.reactionsApi?.getDetailedStats(noteId, articleEventId);
      if (!stats) return;

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

      // Render LikesList if reactions exist — pass the full article event so
      // badge-clicks (additional emoji reactions) can build NIP-25-compliant
      // tags for addressable kinds (long-form articles).
      if (stats.reactionEvents.length > 0) {
        const likesList = new LikesList(stats.reactionEvents, noteId, authorPubkey, articleEvent);
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
      const stats = await this.reactionsApi?.getDetailedStats(noteId);
      if (!stats) return;

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

      // Pre-process Pandoc-style footnotes — marked/GFM doesn't support them natively.
      // Refs are replaced inline; the footnotes <section> is appended after marked parses.
      const { bodyMd, footnotesHtml } = processFootnotes(content);

      // Parse markdown to HTML, then sanitize to prevent XSS (shared whitelist
      // with the editor preview — see sanitizeArticleHtml)
      let html = sanitizeArticleHtml((marked.parse(bodyMd) as string) + footnotesHtml);

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
