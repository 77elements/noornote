/**
 * QuotedNoteRenderer Service
 * Single responsibility: Render quoted notes as quote boxes
 * Used by both NoteUI and SingleNoteView
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { encodeNevent, decodeNip19 } from './NostrToolsAdapter';
import { NoteHeader } from '../components/ui/NoteHeader';
import { CollapsibleManager } from '../components/ui/note-features/CollapsibleManager';
import { QuoteNoteFetcher } from './QuoteNoteFetcher';
import { ArticlePreviewRenderer } from './ArticlePreviewRenderer';
import { ContentProcessor, type QuotedReference } from './ContentProcessor';
import { replaceMediaPlaceholders } from '../helpers/renderMediaContent';
import { replaceBolt11Placeholders } from '../helpers/renderBolt11';
import { Router } from './Router';
import { RENDERABLE_KINDS, GIT_EVENT_KINDS } from '../types/nostr';
import { PollOrchestrator } from './orchestration/PollOrchestrator';
import { MuteOrchestrator } from '../lists/mutes';
import { AuthService } from './AuthService';
import { escapeHtml } from '../helpers/escapeHtml';
import { getTag } from '../helpers/tagUtils';

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
  renderQuotedNotes(
    quotedReferences: QuotedReference[],
    container: Element,
    enableCollapsible: boolean = true,
    parentAuthorPubkey?: string,
  ): void {
    quotedReferences.forEach((ref) => {
      // Route naddr references
      if (ref.type === 'addr') {
        // Decode naddr to check kind — listings (30402) get their own renderer
        try {
          const decoded = decodeNip19(ref.fullMatch.replace(/^nostr:/, ''));
          if (decoded.type === 'naddr' && decoded.data?.kind === 30402) {
            const listingContainer = document.createElement('div');
            container.appendChild(listingContainer);
            void this.renderListingPreview(ref.fullMatch, listingContainer);
            return;
          }
        } catch { /* fall through to article renderer */ }
        this.articleRenderer.renderArticlePreview(ref.fullMatch, container);
        return;
      }

      // Regular note quote handling
      const skeleton = this.createQuoteSkeleton();
      skeleton.dataset.quoteRef = ref.fullMatch;
      container.appendChild(skeleton);

      // Fetch quote in background
      this.fetchAndRenderQuote(ref, skeleton, enableCollapsible, parentAuthorPubkey);
    });
  }

  /**
   * Fetch single quote and update DOM when ready (background task)
   * Made public for use by QuoteRenderer and internal nested quote rendering
   */
  async fetchAndRenderQuote(
    ref: QuotedReference,
    skeleton: HTMLElement,
    enableCollapsible: boolean,
    parentAuthorPubkey?: string,
  ): Promise<void> {
    try {
      const result = await this.quoteFetcher.fetchQuotedEventWithError(ref.fullMatch, parentAuthorPubkey);

      if (result.success) {
        // Unwrap kind:6 / kind:16 reposts: their content field holds the
        // JSON-stringified inner event. Without this, the quote box would
        // process that JSON as plain text and dump it on the page.
        if ((result.event.kind === 6 || result.event.kind === 16) && result.event.content) {
          try {
            const inner = JSON.parse(result.event.content);
            if (inner && typeof inner === 'object' && typeof inner.kind === 'number' && inner.pubkey && inner.id) {
              result.event = inner as NostrEvent;
            }
          } catch {
            // Content wasn't valid JSON — fall through and render the
            // kind:6/16 event as-is (still imperfect, but no regression).
          }
        }

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

        // Route NIP-34 git events (must precede addressable check so 30617 doesn't fall into article preview)
        if (result.event.kind !== undefined && GIT_EVENT_KINDS.includes(result.event.kind)) {
          const { GitEventRenderer } = await import('../components/ui/note-rendering/GitEventRenderer');
          const { GitEventProcessor } = await import('../components/ui/note-processing/GitEventProcessor');
          const processedNote = GitEventProcessor.process(result.event);
          const gitElement = GitEventRenderer.render(processedNote, { collapsible: false, depth: 1 });
          skeleton.replaceWith(gitElement);
          return;
        }

        // Route addressable events (kind 30000-39999)
        if (result.event.kind !== undefined && result.event.kind >= 30000 && result.event.kind < 40000) {
          // Listings (kind 30402) → listing preview
          if (result.event.kind === 30402) {
            const container = document.createElement('div');
            skeleton.replaceWith(container);
            void this.renderListingPreviewFromEvent(result.event, container);
            return;
          }
          // Everything else → article preview
          const { encodeNaddr } = await import('./NostrToolsAdapter');
          const dTag = getTag(result.event.tags, 'd');
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

        // Route NIP-84 highlights (kind 9802) to HighlightRenderer
        if (result.event.kind === 9802) {
          const { HighlightRenderer } = await import('../components/ui/note-rendering/HighlightRenderer');
          const { HighlightProcessor } = await import('../components/ui/note-processing/HighlightProcessor');
          const processedNote = HighlightProcessor.process(result.event);
          const highlightElement = HighlightRenderer.render(processedNote, { collapsible: false, depth: 1 });
          skeleton.replaceWith(highlightElement);
          return;
        }

        // Route NIP-58 badge awards (kind 8) to inline badge card
        if (result.event.kind === 8) {
          const { BadgeAwardRenderer } = await import('../components/ui/note-rendering/BadgeAwardRenderer');
          const card = BadgeAwardRenderer.renderInlineCard(result.event);
          skeleton.replaceWith(card);
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
    let htmlWithMedia = replaceMediaPlaceholders(
      processedContent.html,
      processedContent.media,
      isNSFW,
      eventId,
      event.pubkey
    );
    htmlWithMedia = replaceBolt11Placeholders(htmlWithMedia, processedContent.bolt11Invoices);

    quoteBox.innerHTML = `<div class="event-content">${htmlWithMedia}</div>`;

    // Mount header as first child
    quoteBox.insertBefore(header.getElement(), quoteBox.firstChild);

    // Render nested quoted references (if any). Parent author for the
    // nested fetch is THIS quote's author — its outbound relays are the
    // best guess for resolving whatever it itself quotes.
    if (processedContent.quotedReferences.length > 0) {
      processedContent.quotedReferences.forEach(ref => {
        const marker = quoteBox.querySelector(`.quote-marker[data-quote-ref="${ref.fullMatch}"]`);
        if (marker) {
          const skeleton = this.createQuoteSkeleton();
          marker.replaceWith(skeleton);
          this.fetchAndRenderQuote(ref, skeleton, false, event.pubkey); // No collapsible for nested quotes
        }
      });
    }

    // Render poll options if this is a poll (kind 6969)
    if (event.kind === 6969) {
      this.renderPollOptions(quoteBox, event);
    }

    // Render NIP-88 poll (kind 1068)
    if (event.kind === 1068) {
      const { PollProcessor } = await import('../components/ui/note-processing/PollProcessor');
      const pollData = PollProcessor.extractPollData(event.tags);
      if (pollData.options.length > 0) {
        const { NIP88PollRenderer } = await import('../components/ui/note-features/NIP88PollRenderer');
        NIP88PollRenderer.render(quoteBox, pollData, event).catch(() => {});
      }
    }

    // Setup collapsible for long quoted content (only if enabled).
    // contentSelector keeps the header outside the clamped area.
    if (enableCollapsible) {
      CollapsibleManager.setup(quoteBox, { maxHeight: '40vh', contentSelector: '.event-content' });
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
        target.closest('.note-media')
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

  /**
   * Render a marketplace listing preview from an naddr reference.
   * Fetches the event first, then delegates to renderListingPreviewFromEvent.
   */
  public async renderListingPreview(naddrRef: string, container: Element): Promise<void> {
    try {
      const result = await this.quoteFetcher.fetchQuotedEventWithError(naddrRef);
      if (result.success && result.event.kind === 30402) {
        this.renderListingPreviewFromEvent(result.event, container);
      }
    } catch { /* silent — container stays empty */ }
  }

  /**
   * Render a compact listing card from a Kind 30402 event.
   * Reuses marketplace-helpers for metadata parsing.
   */
  private async renderListingPreviewFromEvent(event: NostrEvent, container: Element): Promise<void> {
    const { parseListingMetadata, formatPrice } = await import('../addons/marketplace/marketplace-helpers');
    const { encodeNaddr } = await import('./NostrToolsAdapter');
    const { UserProfileService } = await import('./UserProfileService');
    const { hexToNpub } = await import('../helpers/nip19');
    const { escapeHtmlAttr } = await import('../helpers/escapeHtml');

    const meta = parseListingMetadata(event);
    const naddr = encodeNaddr({
      kind: 30402,
      pubkey: event.pubkey,
      identifier: meta.identifier,
      relays: []
    });
    const priceDisplay = formatPrice(meta.price, meta.priceCurrency, meta.priceFrequency);
    const firstImage = meta.images[0] || '';

    const card = document.createElement('div');
    card.className = 'timeline-listing-card timeline-listing-card--quoted';
    card.style.cursor = 'pointer';
    card.innerHTML = `
      ${firstImage ? `
        <div class="timeline-listing-card__image">
          <img src="${escapeHtmlAttr(firstImage)}" alt="" loading="lazy" />
        </div>
      ` : ''}
      <div class="timeline-listing-card__body">
        <div class="timeline-listing-card__seller" data-pubkey="${event.pubkey}">
          <a href="#" class="mention-link" data-profile-pubkey="${event.pubkey}">…</a>
          <span class="timeline-listing-card__badge">Marketplace</span>
        </div>
        <h3 class="timeline-listing-card__title">${escapeHtml(meta.title)}</h3>
        <div class="timeline-listing-card__price">${escapeHtml(priceDisplay)}</div>
        ${meta.summary ? `<p class="timeline-listing-card__summary">${escapeHtml(meta.summary.slice(0, 120))}${meta.summary.length > 120 ? '...' : ''}</p>` : ''}
      </div>
    `;

    card.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.note-image--clickable, .note-media, video')) return;
      e.stopPropagation(); // Prevent parent note-card from navigating to SNV
      if ((e.target as HTMLElement).closest('.mention-link')) {
        e.preventDefault();
        const pubkey = (e.target as HTMLElement).closest('[data-profile-pubkey]')?.getAttribute('data-profile-pubkey');
        if (pubkey) {
          const npub = hexToNpub(pubkey);
          if (npub) Router.getInstance().navigate(`/profile/${npub}`);
        }
        return;
      }
      Router.getInstance().navigate(`/listing/${naddr}`);
    });

    container.appendChild(card);

    // Async: load seller name
    try {
      const profile = await UserProfileService.getInstance().getUserProfile(event.pubkey);
      const linkEl = card.querySelector('.mention-link');
      if (linkEl) {
        linkEl.textContent = profile?.name || profile?.display_name || hexToNpub(event.pubkey)?.slice(0, 12) + '...' || '…';
      }
    } catch { /* keep placeholder */ }
  }
}
