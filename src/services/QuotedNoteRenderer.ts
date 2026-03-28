/**
 * QuotedNoteRenderer Service
 * Single responsibility: Render quoted notes as quote boxes
 * Used by both NoteUI and SingleNoteView
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { encodeNevent } from './NostrToolsAdapter';
import { NoteHeader } from '../components/ui/NoteHeader';
import { NoteUI } from '../components/ui/NoteUI';
import { QuoteNoteFetcher } from './QuoteNoteFetcher';
import { ArticlePreviewRenderer } from './ArticlePreviewRenderer';
import { ContentProcessor, type QuotedReference } from './ContentProcessor';
import { replaceMediaPlaceholders } from '../helpers/renderMediaContent';
import { Router } from './Router';
import { RENDERABLE_KINDS } from '../types/nostr';
import { PollOrchestrator } from './orchestration/PollOrchestrator';
import { MuteOrchestrator } from '../lists/mutes';
import { AuthService } from './AuthService';
import { escapeHtml } from '../helpers/escapeHtml';

export class QuotedNoteRenderer {
  private static instance: QuotedNoteRenderer;
  private quoteFetcher: QuoteNoteFetcher;
  private articleRenderer: ArticlePreviewRenderer;
  private contentProcessor: ContentProcessor;
  private muteOrchestrator: ReturnType<typeof MuteOrchestrator.getInstance>;
  private authService: AuthService;

  private constructor() {
    this.quoteFetcher = QuoteNoteFetcher.getInstance();
    this.articleRenderer = ArticlePreviewRenderer.getInstance();
    this.contentProcessor = ContentProcessor.getInstance();
    this.muteOrchestrator = MuteOrchestrator.getInstance();
    this.authService = AuthService.getInstance();
  }

  static getInstance(): QuotedNoteRenderer {
    if (!QuotedNoteRenderer.instance) {
      QuotedNoteRenderer.instance = new QuotedNoteRenderer();
    }
    return QuotedNoteRenderer.instance;
  }

  /**
   * Render quoted notes as quote boxes (NON-BLOCKING)
   * Creates skeletons immediately, fetches in background
   * Handles both regular notes and long-form articles (naddr)
   * @param enableCollapsible - Whether to enable "Show More" for long quotes
   */
  renderQuotedNotes(quotedReferences: QuotedReference[], container: Element, enableCollapsible: boolean = true): void {
    quotedReferences.forEach((ref) => {
      // Route naddr references to ArticlePreviewRenderer
      if (ref.type === 'addr') {
        this.articleRenderer.renderArticlePreview(ref.fullMatch, container);
        return;
      }

      // Regular note quote handling
      const skeleton = this.createQuoteSkeleton();
      skeleton.dataset.quoteRef = ref.fullMatch;
      container.appendChild(skeleton);

      // Fetch quote in background
      this.fetchAndRenderQuote(ref, skeleton, enableCollapsible);
    });
  }

  /**
   * Fetch single quote and update DOM when ready (background task)
   * Made public for use by QuoteRenderer and internal nested quote rendering
   */
  async fetchAndRenderQuote(ref: QuotedReference, skeleton: HTMLElement, enableCollapsible: boolean): Promise<void> {
    try {
      const result = await this.quoteFetcher.fetchQuotedEventWithError(ref.fullMatch);

      if (result.success) {
        // Check if author is muted
        const currentUser = this.authService.getCurrentUser();
        if (currentUser) {
          const muteStatus = await this.muteOrchestrator.isMuted(result.event.pubkey, currentUser.pubkey);
          if (muteStatus.public || muteStatus.private) {
            // Show muted placeholder instead of quote box
            const mutedPlaceholder = this.createMutedPlaceholder(result.event);
            skeleton.replaceWith(mutedPlaceholder);
            return;
          }
        }

        // Route addressable events (kind 30000-39999) to ArticlePreviewRenderer
        if (result.event.kind !== undefined && result.event.kind >= 30000 && result.event.kind < 40000) {
          const { encodeNaddr } = await import('./NostrToolsAdapter');
          const dTag = result.event.tags.find(t => t[0] === 'd')?.[1] || '';
          const naddrRef = 'nostr:' + encodeNaddr({
            kind: result.event.kind,
            pubkey: result.event.pubkey,
            identifier: dTag,
            relays: []
          });
          const container = document.createElement('div');
          skeleton.replaceWith(container);
          this.articleRenderer.renderArticlePreview(naddrRef, container);
          return;
        }

        // Route zap receipts (kind 9735) to ZapReceiptRenderer
        if (result.event.kind === 9735) {
          const { ZapReceiptRenderer } = await import('../components/ui/note-rendering/ZapReceiptRenderer');
          const { ZapReceiptProcessor } = await import('../components/ui/note-processing/ZapReceiptProcessor');
          const processedNote = ZapReceiptProcessor.process(result.event);
          const zapElement = ZapReceiptRenderer.render(processedNote, { collapsible: false });
          skeleton.replaceWith(zapElement);
          return;
        }

        // Route unsupported kinds to UnsupportedKindRenderer
        if (result.event.kind !== undefined && !RENDERABLE_KINDS.includes(result.event.kind)) {
          const { UnsupportedKindRenderer } = await import('../components/ui/note-rendering/UnsupportedKindRenderer');
          const { NoteProcessor } = await import('../components/ui/note-processing/NoteProcessor');
          const processedNote = NoteProcessor.process(result.event);
          const unsupportedElement = UnsupportedKindRenderer.render(processedNote, { collapsible: false });
          skeleton.replaceWith(unsupportedElement);
          return;
        }

        const quoteBox = await this.createQuoteBox(result.event, enableCollapsible);
        skeleton.replaceWith(quoteBox);
      } else {
        const errorElement = this.createQuoteError(result.error);
        skeleton.replaceWith(errorElement);
      }
    } catch (error) {
      console.error(`❌ Quote fetch failed:`, error);
      skeleton.remove();
    }
  }

  /**
   * Create quote box element from event
   * Uses same structure as NoteStructureBuilder for consistent styling
   */
  private async createQuoteBox(event: NostrEvent, enableCollapsible: boolean): Promise<HTMLElement> {
    const quoteBox = document.createElement('div');
    quoteBox.className = 'quote-box';

    // Process event content
    const processedContent = event.tags
      ? this.contentProcessor.processContentWithTags(event.content, event.tags)
      : this.contentProcessor.processContent(event.content);

    // For picture events (Kind 20), extract images from imeta tags and prepend title
    if (event.kind === 20) {
      const { PictureNoteProcessor } = await import('../components/ui/note-processing/PictureNoteProcessor');
      PictureNoteProcessor.prependPictureContent(processedContent, event.tags);
    }

    // For video events (Kind 21/22), extract video from imeta tags and prepend title
    if (event.kind === 21 || event.kind === 22) {
      const { VideoNoteProcessor } = await import('../components/ui/note-processing/VideoNoteProcessor');
      VideoNoteProcessor.prependVideoContent(processedContent, event.tags);
    }

    // For file metadata events (Kind 1063), extract file from NIP-94 tags
    if (event.kind === 1063) {
      const { FileMetadataProcessor } = await import('../components/ui/note-processing/FileMetadataProcessor');
      FileMetadataProcessor.prependFileContent(processedContent, event.tags);
    }

    // Create header (small size for quotes)
    const eventId = event.id;
    if (!eventId) {
      throw new Error('Event must have an id to create quote box');
    }

    const header = new NoteHeader({
      pubkey: event.pubkey,
      eventId,
      timestamp: event.created_at,
      rawEvent: event,
      showVerification: false,
      showTimestamp: true,
      showMenu: true
    });

    // Replace media placeholders in HTML with actual media elements
    const isNSFW = event.tags.some(tag => tag[0] === 'content-warning');
    const htmlWithMedia = replaceMediaPlaceholders(
      processedContent.html,
      processedContent.media,
      isNSFW,
      eventId,
      event.pubkey
    );

    // Use EXACT same structure as NoteStructureBuilder (lines 142-147)
    // NO whitespace between tags - prevents invisible text nodes causing spacing issues
    quoteBox.innerHTML = `<div class="event-header-container"></div><div class="event-content">${htmlWithMedia}</div>`;

    // Mount header
    const headerContainer = quoteBox.querySelector('.event-header-container');
    if (headerContainer) {
      headerContainer.appendChild(header.getElement());
    }

    // Render nested quoted references (if any)
    if (processedContent.quotedReferences.length > 0) {
      processedContent.quotedReferences.forEach(ref => {
        const marker = quoteBox.querySelector(`.quote-marker[data-quote-ref="${ref.fullMatch}"]`);
        if (marker) {
          const skeleton = this.createQuoteSkeleton();
          marker.replaceWith(skeleton);
          this.fetchAndRenderQuote(ref, skeleton, false); // No collapsible for nested quotes
        }
      });
    }

    // Render poll options if this is a poll (kind 6969)
    if (event.kind === 6969) {
      this.renderPollOptions(quoteBox, event);
    }

    // Setup collapsible for long quoted content (only if enabled)
    if (enableCollapsible) {
      NoteUI.setupCollapsible(quoteBox);
    }

    // Add click handler to navigate to SNV (exclude interactive elements)
    quoteBox.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      // Don't navigate if clicking on interactive elements
      if (
        target.tagName === 'A' ||
        target.tagName === 'BUTTON' ||
        target.tagName === 'IMG' ||
        target.tagName === 'VIDEO' ||
        target.closest('a') ||
        target.closest('button') ||
        target.closest('.note-header') ||
        target.closest('.hashtag') ||
        target.closest('.note-media') ||
        target.closest('.note-media-inline')
      ) {
        return;
      }

      // Navigate to SNV for this quoted note
      const router = Router.getInstance();
      const nevent = encodeNevent(eventId);
      router.navigate(`/note/${nevent}`);
    });

    // Add cursor pointer style
    quoteBox.style.cursor = 'pointer';

    return quoteBox;
  }

  /**
   * Create placeholder for muted user's quoted note
   */
  private createMutedPlaceholder(event: NostrEvent): HTMLElement {
    const eventId = event.id ?? '';
    const placeholder = document.createElement('div');
    placeholder.className = 'quote-muted';
    if (eventId) {
      placeholder.dataset.eventId = eventId;
    }
    placeholder.dataset.authorPubkey = event.pubkey;

    placeholder.innerHTML = `
      <div class="quote-muted__content">
        <span class="quote-muted__icon">🔇</span>
        <div class="quote-muted__text">
          <p>Note from a user you've muted</p>
          <button class="quote-muted__show-btn" data-event-id="${eventId}">Show temporarily</button>
        </div>
      </div>
    `;

    // Add click handler for "Show temporarily" button
    const showBtn = placeholder.querySelector('.quote-muted__show-btn');
    if (showBtn) {
      showBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        // Replace placeholder with actual quote box
        const quoteBox = await this.createQuoteBox(event, true);
        placeholder.replaceWith(quoteBox);
      });
    }

    return placeholder;
  }

  /**
   * Create error element for failed quote fetch
   */
  private createQuoteError(error: any): HTMLElement {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'quote-error';
    // NO whitespace to prevent invisible text nodes
    errorDiv.innerHTML = `<div class="quote-error-content"><span class="error-icon">⚠️</span><span class="error-text">${escapeHtml(error.message || 'Failed to load quoted note')}</span></div>`;
    return errorDiv;
  }

  /**
   * Render poll options for kind:6969 poll events
   * Fetches vote counts via PollOrchestrator and displays results
   */
  private renderPollOptions(quoteBox: HTMLElement, event: NostrEvent): void {
    const eventId = event.id;
    if (!eventId) return;

    // Parse poll options from tags, filtering out invalid entries
    const pollOptions = event.tags
      .filter(tag => tag[0] === 'poll_option' && tag[1] && tag[2])
      .map(tag => ({ id: tag[1] as string, label: tag[2] as string, voteCount: 0 }))
      .sort((a, b) => parseInt(a.id) - parseInt(b.id));

    if (pollOptions.length === 0) return;

    const pollContainer = document.createElement('div');
    pollContainer.className = 'poll-options';

    pollOptions.forEach(option => {
      const optionBtn = document.createElement('button');
      optionBtn.className = 'poll-option';
      optionBtn.disabled = true;
      optionBtn.dataset.optionIndex = option.id;
      optionBtn.innerHTML = `
        <span class="poll-option-text">${option.label}</span>
        <span class="poll-option-stats">
          <span class="poll-option-count">Loading...</span>
        </span>
      `;
      pollContainer.appendChild(optionBtn);
    });

    // Insert poll options after quote-content
    const quoteContent = quoteBox.querySelector('.quote-content');
    if (quoteContent) {
      quoteContent.appendChild(pollContainer);
    }

    // Fetch poll results asynchronously
    const pollOrchestrator = PollOrchestrator.getInstance();
    pollOrchestrator.fetchPollResults(eventId, pollOptions).then(results => {
        // Update UI with vote counts
        results.options.forEach(option => {
          const optionBtn = pollContainer.querySelector(`[data-option-index="${option.id}"]`) as HTMLElement | null;
          if (!optionBtn) return;

          const countSpan = optionBtn.querySelector('.poll-option-count');
          if (!countSpan) return;

          // Calculate percentage
          const percentage = results.totalVotes > 0
            ? Math.round((option.voteCount / results.totalVotes) * 100)
            : 0;

          // Update text
          countSpan.textContent = `${percentage}% (${option.voteCount} ${option.voteCount === 1 ? 'vote' : 'votes'})`;

          // Add progress bar background
          optionBtn.style.setProperty('--vote-percentage', `${percentage}%`);
          optionBtn.classList.add('has-votes');
        });
    }).catch(error => {
        console.warn('Failed to fetch poll results:', error);
        // Show error state
        pollOptions.forEach(option => {
          const optionBtn = pollContainer.querySelector(`[data-option-index="${option.id}"]`);
          if (!optionBtn) return;

          const countSpan = optionBtn.querySelector('.poll-option-count');
          if (countSpan) {
            countSpan.textContent = 'Failed to load votes';
          }
        });
    });
  }

  /**
   * Create skeleton loader for quoted note during fetch
   * Made public for use by QuoteRenderer
   */
  createQuoteSkeleton(): HTMLElement {
    const skeleton = document.createElement('div');
    skeleton.className = 'quote-skeleton';
    // NO whitespace to prevent invisible text nodes causing spacing issues
    skeleton.innerHTML = `<div class="skeleton-header"><div class="skeleton-avatar"></div><div class="skeleton-text-group"><div class="skeleton-line skeleton-name"></div><div class="skeleton-line skeleton-timestamp"></div></div></div><div class="skeleton-content"><div class="skeleton-line skeleton-text-line"></div><div class="skeleton-line skeleton-text-line"></div><div class="skeleton-line skeleton-text-line short"></div></div>`;

    return skeleton;
  }
}
