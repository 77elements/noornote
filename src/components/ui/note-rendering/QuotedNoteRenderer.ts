/**
 * QuotedNoteRenderer Service
 * Single responsibility: Render quoted notes as quote boxes
 * Used by both NoteUI and SingleNoteView
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { encodeNevent, decodeNip19 } from '../../../services/NostrToolsAdapter';
import { NoteHeader } from '../../../components/ui/NoteHeader';
import { CollapsibleManager } from '../../../components/ui/note-features/CollapsibleManager';
import {
  QuoteNoteFetcher,
  type QuoteFetchError,
} from '../../../services/QuoteNoteFetcher';
import { ArticlePreviewRenderer } from './ArticlePreviewRenderer';
import {
  ContentProcessor,
  type QuotedReference,
} from '../../../services/ContentProcessor';
import { replaceMediaPlaceholders } from '../../../helpers/renderMediaContent';
import { replaceBolt11Placeholders } from '../../../helpers/renderBolt11';
import { Router } from '../../../services/Router';
import { getViewNavigationController } from '../../../services/ViewNavigationController';
import { RENDERABLE_KINDS, GIT_EVENT_KINDS } from '../../../types/nostr';
import { PollRenderer } from '../note-features/PollRenderer';
import { MuteOrchestrator } from '../../../lists/mutes';
import { AuthService } from '../../../services/AuthService';
import { escapeHtml } from '../../../helpers/escapeHtml';
import { getTag } from '../../../helpers/tagUtils';
import { TypedEventBus } from '../../../core/TypedEventBus';
import {
  DittoFeatureRenderer,
  DITTO_GEOCACHE_KIND,
} from '../../../components/ui/note-rendering/DittoFeatureRenderer';
import {
  SatelliteSiteRenderer,
  SATELLITE_SITE_KIND,
} from '../../../components/ui/note-rendering/SatelliteSiteRenderer';
import { ArmadaInviteRenderer } from '../../../components/ui/note-rendering/ArmadaInviteRenderer';
import { UnsupportedKindRenderer } from './UnsupportedKindRenderer';
import { GatedNoteRenderer } from './GatedNoteRenderer';
import { isGatedNoteEvent } from '../../../helpers/gatedNote';
import { ARTICLE_PREVIEW_KINDS } from '../../../helpers/addressableKinds';
import {
  parseListingMetadata,
  formatPrice,
} from '../../../helpers/listingMetadata';

export class QuotedNoteRenderer {
  private static instance: QuotedNoteRenderer;
  /** Rendered quote levels; deeper nested quotes become the depth-cap placeholder. */
  private static readonly MAX_QUOTE_DEPTH = 3;
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
    parentAuthorPubkey?: string
  ): void {
    quotedReferences.forEach(ref => {
      // Route naddr references by kind (listing / article / Ditto / unsupported).
      if (ref.type === 'addr') {
        const addrContainer = document.createElement('div');
        container.appendChild(addrContainer);
        this.renderAddressableReference(
          ref.fullMatch,
          addrContainer,
          ref.fragment
        );
        return;
      }

      // Regular note quote handling
      const skeleton = this.createQuoteSkeleton();
      skeleton.dataset.quoteRef = ref.fullMatch;
      container.appendChild(skeleton);

      // Fetch quote in background
      void this.fetchAndRenderQuote(
        ref,
        skeleton,
        enableCollapsible,
        parentAuthorPubkey
      );
    });
  }

  /**
   * Route an addressable (naddr) quote reference by kind, from the coordinate
   * alone (no fetch). Known kinds get their dedicated card; everything else
   * gets the shared "unsupported" fallback with an "open in another client"
   * (njump) link — NEVER the article renderer. This is why a proprietary /
   * community addressable event no longer shows a bogus "Failed to load
   * article" card. Shared by OriginalNoteRenderer, QuoteRenderer and the
   * conversation path so the rule lives in one place.
   *
   * `fragment` is the Armada invite unlock secret (without leading `#`),
   * preserved through extractQuotedReferences → ContentProcessor → here
   * when the original note text carried an `armada.buzz/invite/<naddr>#<frag>`
   * URL. Without it the renderer falls back to the static "Encrypted community"
   * card; with it, the bundle is decrypted for a real preview.
   */
  public renderAddressableReference(
    naddrRef: string,
    container: Element,
    fragment?: string
  ): void {
    let kind: number | undefined;
    let pubkey = '';
    let identifier = '';
    let decodedNaddr = false;
    try {
      // Strip the `nostr:` prefix AND any `#fragment` (armada invite unlock
      // secret, preserved through extractQuotedReferences) — decodeNip19
      // rejects bech32 strings with a trailing `#…` since `#` is not a
      // bech32 character. The fragment travels separately via the parameter.
      const bare = naddrRef.replace(/^nostr:/, '').split('#')[0] ?? naddrRef;
      const decoded = decodeNip19(bare);
      if (decoded.type === 'naddr') {
        kind = decoded.data.kind;
        pubkey = decoded.data.pubkey;
        identifier = decoded.data.identifier;
        decodedNaddr = true;
      }
    } catch {
      /* fall through to the unsupported fallback below */
    }

    // REGULAR note kinds wrapped in an naddr: some publishers encode plain
    // kind-1 notes as naddr URLs (e.g. fanfares.io). These are NOT addressable
    // cards — route them through the regular quote pipeline; the naddr carries
    // the relay hints, and the depth cap applies like any other quote.
    if (decodedNaddr && typeof kind === 'number' && kind < 30000) {
      const skeleton = this.createQuoteSkeleton();
      container.appendChild(skeleton);
      void this.fetchAndRenderQuote(
        { fullMatch: naddrRef, type: 'addr' } as QuotedReference,
        skeleton,
        true
      );
      return;
    }

    // Marketplace listings (kind 30402) → listing preview.
    if (kind === 30402) {
      void this.renderListingPreview(naddrRef, container);
      return;
    }
    // Ditto geocache (kind 37516): proprietary, no NIP — dedicated notice.
    if (kind === DITTO_GEOCACHE_KIND) {
      container.appendChild(
        DittoFeatureRenderer.renderFromCoordinate(kind, pubkey, identifier)
      );
      return;
    }
    // Satellite Earth site page (kind 35129): proprietary, no NIP — dedicated notice.
    if (kind === SATELLITE_SITE_KIND) {
      container.appendChild(
        SatelliteSiteRenderer.renderFromCoordinate(kind, pubkey, identifier)
      );
      return;
    }
    // Armada / Concord encrypted community invite (kind 33301, CORD-05):
    // NIP-44-encrypted bundle. With the URL fragment we can decrypt the
    // public preview (name, icon, channels); without it we still show the
    // "Open in Armada" card. naddrRef is the full `nostr:naddr1…` (with
    // optional `#fragment` already stripped by extractQuotedReferences);
    // we pass the bare naddr + fragment to the renderer.
    if (kind === 33301) {
      // `bare` already has the nostr: prefix and #fragment stripped above;
      // pass it directly with the separately-travelled fragment.
      const bare = naddrRef.replace(/^nostr:/, '').split('#')[0] ?? naddrRef;
      container.appendChild(
        ArmadaInviteRenderer.renderFromCoordinate(bare, fragment)
      );
      return;
    }
    // Follow pack (kind 39089) → fetch + render via FollowPackRenderer (.nn-card).
    if (kind === 39089) {
      void this.renderFollowPackPreview(naddrRef, container);
      return;
    }
    // Article / Zapstore app / live stream → article-preview renderer.
    if (kind !== undefined && ARTICLE_PREVIEW_KINDS.has(kind)) {
      this.articleRenderer.renderArticlePreview(naddrRef, container);
      return;
    }
    // Any other addressable kind → shared unsupported fallback (no article card).
    container.appendChild(
      UnsupportedKindRenderer.renderFromCoordinate(
        kind ?? 0,
        pubkey,
        identifier
      )
    );
  }

  /**
   * Fetch single quote and update DOM when ready (background task)
   * Made public for use by QuoteRenderer and internal nested quote rendering
   *
   * @param isRetry - Internal flag set by {@link scheduleQuoteRetry}: when true,
   *     a failed fetch falls straight through to the error UI without scheduling
   *     another retry (one retry per quote — see the recovery design).
   */
  async fetchAndRenderQuote(
    ref: QuotedReference,
    skeleton: HTMLElement,
    enableCollapsible: boolean,
    parentAuthorPubkey?: string,
    isRetry: boolean = false,
    depth: number = 1
  ): Promise<void> {
    // Depth cap: nested quoted-repost chains may render 3 levels; anything
    // deeper becomes a clickable placeholder (perspective shift via open —
    // that view starts fresh at level 1 with its own 3 levels). No fetch, no
    // skeleton, no recovery — a runaway chain can no longer storm the relays.
    if (depth > QuotedNoteRenderer.MAX_QUOTE_DEPTH) {
      skeleton.replaceWith(this.createDepthCapPlaceholder(ref));
      return;
    }
    try {
      // Always fetch the normal path here. The retry-vs-not distinction lives
      // ONLY in the error branch below — `isRetry` decides whether a failure
      // schedules another recovery attempt (first failure) or shows the final
      // error UI (recovery already happened). The outboundOnly flag is set
      // inside scheduleQuoteRecovery's 8 s timer, NOT here, so a successful
      // recovery re-render still walks the full cache-first pipeline.
      const result = await this.quoteFetcher.fetchQuotedEventWithError(
        ref.fullMatch,
        parentAuthorPubkey
      );

      if (result.success) {
        // Gated premium notes (fanfares): render the unlock card — the teaser
        // CTA is self-referential and would recurse into the same event.
        if (isGatedNoteEvent(result.event)) {
          skeleton.replaceWith(GatedNoteRenderer.renderQuoteCard(result.event));
          return;
        }
        // Unwrap kind:6 / kind:16 reposts: their content field holds the
        // JSON-stringified inner event. Without this, the quote box would
        // process that JSON as plain text and dump it on the page.
        if (
          (result.event.kind === 6 || result.event.kind === 16) &&
          result.event.content
        ) {
          try {
            // kind:6/16 repost embeds the original event (relay-controlled)
            const inner = JSON.parse(result.event.content) as {
              kind?: unknown;
              pubkey?: unknown;
              id?: unknown;
            };
            if (
              inner &&
              typeof inner === 'object' &&
              typeof inner.kind === 'number' &&
              inner.pubkey &&
              inner.id
            ) {
              result.event = inner as unknown as NostrEvent;
            }
          } catch {
            // Content wasn't valid JSON — fall through and render the
            // kind:6/16 event as-is (still imperfect, but no regression).
          }
        }

        // Check if author is muted
        const currentUser = this.authService.getCurrentUser();
        if (currentUser) {
          const muteStatus = await this.muteOrchestrator.isMuted(
            result.event.pubkey,
            currentUser.pubkey
          );
          if (muteStatus.public || muteStatus.private) {
            // Show muted placeholder instead of quote box
            const mutedPlaceholder = this.createMutedPlaceholder(
              result.event,
              depth
            );
            skeleton.replaceWith(mutedPlaceholder);
            return;
          }
        }

        // Ditto geocache (kind 37516): proprietary, no NIP — must precede the
        // addressable check below, which would otherwise dump it into the
        // article-preview renderer and produce garbage.
        if (result.event.kind === DITTO_GEOCACHE_KIND) {
          skeleton.replaceWith(DittoFeatureRenderer.render(result.event));
          return;
        }

        // Satellite Earth site page (kind 35129): proprietary, no NIP — same
        // reason as the Ditto branch above.
        if (result.event.kind === SATELLITE_SITE_KIND) {
          skeleton.replaceWith(SatelliteSiteRenderer.render(result.event));
          return;
        }

        // Route NIP-34 git events (must precede addressable check so 30617 doesn't fall into article preview)
        if (
          result.event.kind !== undefined &&
          GIT_EVENT_KINDS.includes(result.event.kind)
        ) {
          const { GitEventRenderer } = await import(
            '../../../components/ui/note-rendering/GitEventRenderer'
          );
          const { GitEventProcessor } = await import(
            '../../../components/ui/note-processing/GitEventProcessor'
          );
          const processedNote = GitEventProcessor.process(result.event);
          const gitElement = GitEventRenderer.render(processedNote, {
            collapsible: false,
            depth: 1,
          });
          skeleton.replaceWith(gitElement);
          return;
        }

        // Route addressable events (kind 30000-39999)
        if (
          result.event.kind !== undefined &&
          result.event.kind >= 30000 &&
          result.event.kind < 40000
        ) {
          // Listings (kind 30402) → listing preview
          if (result.event.kind === 30402) {
            const container = document.createElement('div');
            skeleton.replaceWith(container);
            void this.renderListingPreviewFromEvent(result.event, container);
            return;
          }
          // NIP-30 emoji packs (kind 30030) → emoji-pack card
          if (result.event.kind === 30030) {
            const { EmojiPackRenderer } = await import(
              '../../../components/ui/note-rendering/EmojiPackRenderer'
            );
            const { EmojiPackProcessor } = await import(
              '../../../components/ui/note-processing/EmojiPackProcessor'
            );
            const processedNote = EmojiPackProcessor.process(result.event);
            const packElement = EmojiPackRenderer.render(processedNote, {
              collapsible: false,
              depth: 1,
            });
            skeleton.replaceWith(packElement);
            return;
          }
          // Follow packs (kind 39089) → .nn-card via FollowPackRenderer.
          if (result.event.kind === 39089) {
            const packElement = await this.buildFollowPackElement(result.event);
            skeleton.replaceWith(packElement);
            return;
          }
          // Article / Zapstore app / live stream → article-preview renderer.
          if (ARTICLE_PREVIEW_KINDS.has(result.event.kind)) {
            const { encodeNaddr } = await import(
              '../../../services/NostrToolsAdapter'
            );
            const dTag = getTag(result.event.tags, 'd');
            const naddrRef = `nostr:${encodeNaddr({
              kind: result.event.kind,
              pubkey: result.event.pubkey,
              identifier: dTag,
              relays: [],
            })}`;
            const container = document.createElement('div');
            skeleton.replaceWith(container);
            this.articleRenderer.renderArticlePreview(naddrRef, container);
            return;
          }
          // Any other addressable kind → shared unsupported fallback (never an
          // article card). We have the fetched event, so render from it directly.
          {
            const { NoteProcessor } = await import(
              '../../../components/ui/note-processing/NoteProcessor'
            );
            const processedNote = NoteProcessor.process(result.event);
            skeleton.replaceWith(
              UnsupportedKindRenderer.render(processedNote, {
                collapsible: false,
              })
            );
            return;
          }
        }

        // Route NIP-84 highlights (kind 9802) to HighlightRenderer
        if (result.event.kind === 9802) {
          const { HighlightRenderer } = await import(
            '../../../components/ui/note-rendering/HighlightRenderer'
          );
          const { HighlightProcessor } = await import(
            '../../../components/ui/note-processing/HighlightProcessor'
          );
          const processedNote = HighlightProcessor.process(result.event);
          const highlightElement = HighlightRenderer.render(processedNote, {
            collapsible: false,
            depth: 1,
          });
          skeleton.replaceWith(highlightElement);
          return;
        }

        // Route NIP-58 badge awards (kind 8) to inline badge card
        if (result.event.kind === 8) {
          const { BadgeAwardRenderer } = await import(
            '../../../components/ui/note-rendering/BadgeAwardRenderer'
          );
          const card = BadgeAwardRenderer.renderInlineCard(result.event);
          skeleton.replaceWith(card);
          return;
        }

        // Route zap receipts (kind 9735) to ZapReceiptRenderer
        if (result.event.kind === 9735) {
          const { ZapReceiptRenderer } = await import(
            '../../../components/ui/note-rendering/ZapReceiptRenderer'
          );
          const { ZapReceiptProcessor } = await import(
            '../../../components/ui/note-processing/ZapReceiptProcessor'
          );
          const processedNote = ZapReceiptProcessor.process(result.event);
          const zapElement = ZapReceiptRenderer.render(processedNote, {
            collapsible: false,
          });
          skeleton.replaceWith(zapElement);
          return;
        }

        // Route unsupported kinds to UnsupportedKindRenderer
        if (
          result.event.kind !== undefined &&
          !RENDERABLE_KINDS.includes(result.event.kind)
        ) {
          const { UnsupportedKindRenderer } = await import(
            '../../../components/ui/note-rendering/UnsupportedKindRenderer'
          );
          const { NoteProcessor } = await import(
            '../../../components/ui/note-processing/NoteProcessor'
          );
          const processedNote = NoteProcessor.process(result.event);
          const unsupportedElement = UnsupportedKindRenderer.render(
            processedNote,
            { collapsible: false }
          );
          skeleton.replaceWith(unsupportedElement);
          return;
        }

        const quoteBox = await this.createQuoteBox(
          result.event,
          enableCollapsible,
          depth
        );
        skeleton.replaceWith(quoteBox);
      } else if (this.isUnresolvableByDesign(ref)) {
        // Zap receipts (kind 9735) are routinely unreachable by id alone: they
        // live on the recipient's / zap-request's relays, not derivable from a
        // hint-less nevent or any outbox (see QuoteOrchestrator). Silently drop
        // the dead quote instead of showing a "not found" box for something we
        // can never resolve anyway.
        skeleton.remove();
      } else if (isRetry) {
        // The retry attempt failed too — the note really isn't reachable right
        // now. Show the final error UI. Without this branch the second failure
        // would schedule a third attempt and we'd never converge.
        skeleton.replaceWith(this.createQuoteError(result.error));
      } else {
        // First failure: instead of freezing on a "not found" box, leave the
        // skeleton in place and try to recover via (a) the global note:cached
        // event — fired by NoteService whenever any path lands the note in the
        // LRU — and (b) a single outboundOnly retry against the now-warm
        // outbound relays. The error UI is shown only if neither path delivers
        // within the recovery window.
        this.scheduleQuoteRecovery(
          ref,
          skeleton,
          enableCollapsible,
          parentAuthorPubkey,
          result.error,
          depth
        );
      }
    } catch (error) {
      console.error(`❌ Quote fetch failed:`, error);
      skeleton.remove();
    }
  }

  /**
   * Wait for a previously-unresolved quote to arrive via any of:
   *   1. A `note:cached` event from NoteService (background feed subscription,
   *      a parallel fetch, an NDK subscription that resolved late, …).
   *   2. A single outboundOnly retry after 8 s — by then the outbound relays
   *      (notably a bridge relay like mostr.pub the quoter used) have usually
   *      finished their first TLS handshake of the session and EOSE properly.
   *
   * If neither delivers within 60 s, the final error UI replaces the skeleton.
   * All three timers (listener, retry, fail) are de-registered on any
   * resolution, on DOM detach, and on recursive re-entry — otherwise long
   * feeds leak listeners.
   */
  private scheduleQuoteRecovery(
    ref: QuotedReference,
    skeleton: HTMLElement,
    enableCollapsible: boolean,
    parentAuthorPubkey: string | undefined,
    error: QuoteFetchError,
    depth: number = 1
  ): void {
    let resolved = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let failTimer: ReturnType<typeof setTimeout> | undefined;
    let noteCachedSubId: string | undefined;

    const eventBus = TypedEventBus.getInstance();
    const eventId = QuotedNoteRenderer.extractEventIdFromRef(ref);

    const cleanup = (): void => {
      resolved = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      if (failTimer) {
        clearTimeout(failTimer);
        failTimer = undefined;
      }
      if (noteCachedSubId) {
        eventBus.off(noteCachedSubId);
        noteCachedSubId = undefined;
      }
    };

    // Bail out silently if the skeleton is no longer in the DOM (timeline
    // trimmed the card, view switched, etc.). Re-rendering into a detached
    // node would do nothing visible and leak the new element.
    const isAlive = (): boolean => !resolved && skeleton.isConnected;

    // Path 1: subscribe to note:cached for this id. NoteService fires it
    // whenever ANY code path adds the note to the LRU — feed subscriptions,
    // parallel orchestrator fetches, even unrelated lookups. This is the
    // "the note arrived via a different door" recovery.
    if (eventId) {
      noteCachedSubId = eventBus.on(
        'note:cached',
        (data: { eventId: string }) => {
          if (!isAlive()) {
            cleanup();
            return;
          }
          if (data.eventId === eventId) {
            cleanup();
            // Cache-first Stage 0 will resolve instantly.
            void this.fetchAndRenderQuote(
              ref,
              skeleton,
              enableCollapsible,
              parentAuthorPubkey,
              true,
              depth
            );
          }
        }
      );
    }

    // Path 2: scheduled outboundOnly retry. The initial fetch already proved
    // the user's read relays and the indexer set carry nothing (cold or
    // EOSE-empty); re-running those stages only burns identical timeouts.
    // Stage 3 with the now-warm outbound sockets is the one path whose result
    // actually changes on a second attempt.
    retryTimer = setTimeout(() => {
      if (!isAlive()) {
        cleanup();
        return;
      }
      void this.quoteFetcher
        .fetchQuotedEventWithError(ref.fullMatch, parentAuthorPubkey, true)
        .then(result => {
          if (!isAlive()) {
            cleanup();
            return;
          }
          if (result.success) {
            cleanup();
            void this.fetchAndRenderQuote(
              ref,
              skeleton,
              enableCollapsible,
              parentAuthorPubkey,
              true,
              depth
            );
          }
          // else: failTimer still scheduled — leave skeleton in place.
        })
        .catch(() => {
          /* network errors during retry: rely on failTimer */
        });
    }, 8000);

    // Path 3: final fallback after the recovery window. We've given both
    // signals (background arrival + active retry) a fair chance; the note
    // really isn't reachable right now.
    failTimer = setTimeout(() => {
      if (!isAlive()) {
        cleanup();
        return;
      }
      cleanup();
      skeleton.replaceWith(this.createQuoteError(error));
    }, 60000);
  }

  /**
   * Pull the hex event id out of a QuotedReference (note1 / nevent1 / hex).
   * Returns null for naddr (addressable refs have no single id — they live
   * on a different fetch path and aren't relevant for note:cached recovery).
   */
  private static extractEventIdFromRef(ref: QuotedReference): string | null {
    try {
      const cleanRef = ref.fullMatch.replace(/^nostr:/, '');
      // bech32 first (handles off-by-one checksum tolerance like the orchestrator)
      for (const candidate of [cleanRef, cleanRef.slice(0, -1)]) {
        try {
          const decoded = decodeNip19(candidate);
          if (decoded.type === 'note') return decoded.data as string;
          if (decoded.type === 'nevent') {
            const data = decoded.data as { id?: string };
            if (data.id) return data.id;
          }
          break;
        } catch {
          /* try next variant */
        }
      }
      if (cleanRef.match(/^[a-f0-9]{64}$/)) return cleanRef;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Create quote box element from event
   * Uses same structure as NoteStructureBuilder for consistent styling
   */
  private async createQuoteBox(
    event: NostrEvent,
    enableCollapsible: boolean,
    depth: number = 1
  ): Promise<HTMLElement> {
    const quoteBox = document.createElement('div');
    quoteBox.className = 'quote-box';

    // Process event content
    const processedContent = event.tags
      ? this.contentProcessor.processContentWithTags(event.content, event.tags)
      : this.contentProcessor.processContent(event.content);

    // For picture events (Kind 20), extract images from imeta tags and prepend title
    if (event.kind === 20) {
      const { PictureNoteProcessor } = await import(
        '../../../components/ui/note-processing/PictureNoteProcessor'
      );
      PictureNoteProcessor.prependPictureContent(processedContent, event.tags);
    }

    // For video events (Kind 21/22), extract video from imeta tags and prepend title
    if (event.kind === 21 || event.kind === 22) {
      const { VideoNoteProcessor } = await import(
        '../../../components/ui/note-processing/VideoNoteProcessor'
      );
      VideoNoteProcessor.prependVideoContent(processedContent, event.tags);
    }

    // For file metadata events (Kind 1063), extract file from NIP-94 tags
    if (event.kind === 1063) {
      const { FileMetadataProcessor } = await import(
        '../../../components/ui/note-processing/FileMetadataProcessor'
      );
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
      showMenu: true,
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
    htmlWithMedia = replaceBolt11Placeholders(
      htmlWithMedia,
      processedContent.bolt11Invoices
    );

    quoteBox.innerHTML = `<div class="event-content">${htmlWithMedia}</div>`;

    // Mount header as first child
    quoteBox.insertBefore(header.getElement(), quoteBox.firstChild);

    // Render nested quoted references (if any). Parent author for the
    // nested fetch is THIS quote's author — its outbound relays are the
    // best guess for resolving whatever it itself quotes.
    if (processedContent.quotedReferences.length > 0) {
      processedContent.quotedReferences.forEach(ref => {
        const marker = quoteBox.querySelector(
          `.quote-marker[data-quote-ref="${ref.fullMatch}"]`
        );
        if (marker) {
          const skeleton = this.createQuoteSkeleton();
          marker.replaceWith(skeleton);
          // No collapsible for nested quotes; nested level = depth + 1
          void this.fetchAndRenderQuote(
            ref,
            skeleton,
            false,
            event.pubkey,
            false,
            depth + 1
          );
        }
      });
    }

    // Render poll options if this is a poll (kind 6969)
    if (event.kind === 6969) {
      this.renderPollOptions(quoteBox, event);
    }

    // Render NIP-88 poll (kind 1068)
    if (event.kind === 1068) {
      const { PollProcessor } = await import(
        '../../../components/ui/note-processing/PollProcessor'
      );
      const pollData = PollProcessor.extractPollData(event.tags);
      if (pollData.options.length > 0) {
        const { NIP88PollRenderer } = await import(
          '../../../components/ui/note-features/NIP88PollRenderer'
        );
        NIP88PollRenderer.render(quoteBox, pollData, event).catch(() => {});
      }
    }

    // Setup collapsible for long quoted content (only if enabled).
    // contentSelector keeps the header outside the clamped area.
    if (enableCollapsible) {
      CollapsibleManager.setup(quoteBox, {
        maxHeight: '40vh',
        contentSelector: '.event-content',
      });
    }

    // Add click handler to navigate to SNV (exclude interactive elements)
    quoteBox.addEventListener('click', e => {
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

      // Navigate to SNV for this quoted note. Route through the central controller
      // so right-pane mode opens it in the secondary pane (scc), not the timeline (pcc).
      const nevent = encodeNevent(eventId);
      getViewNavigationController().openView('single-note', nevent, e);
    });

    // Add cursor pointer style
    quoteBox.style.cursor = 'pointer';

    return quoteBox;
  }

  /**
   * Create placeholder for muted user's quoted note
   */
  private createMutedPlaceholder(
    event: NostrEvent,
    depth: number = 1
  ): HTMLElement {
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
      showBtn.addEventListener('click', async e => {
        e.stopPropagation();
        // Replace placeholder with actual quote box
        const quoteBox = await this.createQuoteBox(event, true, depth);
        placeholder.replaceWith(quoteBox);
      });
    }

    return placeholder;
  }

  /**
   * Create error element for failed quote fetch
   */
  /**
   * Whether a quote we failed to fetch is one we should silently drop rather
   * than show a "not found" box for. The nevent reference still carries the
   * kind even when the event is unfetchable; zap receipts (kind 9735) can't be
   * resolved by id alone (see QuoteOrchestrator), so there is no point showing
   * an error the user can do nothing about.
   */
  private isUnresolvableByDesign(ref: QuotedReference): boolean {
    try {
      const decoded = decodeNip19(ref.fullMatch.replace(/^nostr:/, ''));
      if (decoded.type === 'nevent') {
        return (decoded.data as { kind?: number }).kind === 9735;
      }
    } catch {
      // Not decodable → no kind hint, keep the normal error path.
    }
    return false;
  }

  private createQuoteError(error: unknown): HTMLElement {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'quote-error';
    // NO whitespace to prevent invisible text nodes
    errorDiv.innerHTML = `<div class="quote-error-content"><span class="error-icon">⚠️</span><span class="error-text">${escapeHtml(
      (error instanceof Error ? error.message : '') ||
        'Failed to load quoted note'
    )}</span></div>`;
    return errorDiv;
  }

  /**
   * Depth-cap placeholder for deeply nested quoted-repost chains: the card
   * looks like a note skeleton, but carries a text instead of skeleton bars.
   * Fully clickable — opening it navigates to the quoted note, whose own view
   * renders the next 3 levels from that perspective (no invented IDs/hex).
   */
  private createDepthCapPlaceholder(ref: QuotedReference): HTMLElement {
    const placeholder = document.createElement('div');
    placeholder.className = 'quote-depth-cap';
    placeholder.dataset.quoteRef = ref.fullMatch;
    placeholder.innerHTML = `<div class="quote-depth-cap__content"><span class="quote-depth-cap__icon">📄</span><span class="quote-depth-cap__text">Quoted repost — open to view</span></div>`;

    placeholder.addEventListener('click', e => {
      // Inviolable media-click rule: media inside the placeholder must never
      // be pre-empted by this navigation handler (defensive — the placeholder
      // contains no media today, but this keeps the guard invariant intact).
      const target = e.target as HTMLElement;
      if (
        target.closest('.note-image--clickable') ||
        target.closest('.note-media') ||
        target.tagName === 'VIDEO'
      ) {
        return;
      }
      e.stopPropagation();
      const router = Router.getInstance();
      router.navigate(`/note/${ref.fullMatch.replace(/^nostr:/, '')}`);
    });

    return placeholder;
  }

  /**
   * Render poll options for kind:6969 poll events inside a quote box.
   * UI building blocks + result fetching live in PollRenderer.
   */
  private renderPollOptions(quoteBox: HTMLElement, event: NostrEvent): void {
    const eventId = event.id;
    if (!eventId) return;

    const pollOptions = PollRenderer.extractOptions(event.tags);
    if (pollOptions.length === 0) return;

    const pollContainer = PollRenderer.buildOptionsContainer(pollOptions);

    // Insert poll options after quote-content
    const quoteContent = quoteBox.querySelector('.quote-content');
    if (quoteContent) {
      quoteContent.appendChild(pollContainer);
    }

    PollRenderer.fetchAndFill(eventId, pollOptions, pollContainer);
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
  public async renderListingPreview(
    naddrRef: string,
    container: Element
  ): Promise<void> {
    try {
      const result =
        await this.quoteFetcher.fetchQuotedEventWithError(naddrRef);
      if (result.success && result.event.kind === 30402) {
        void this.renderListingPreviewFromEvent(result.event, container);
      }
    } catch {
      /* silent — container stays empty */
    }
  }

  /**
   * Render a follow pack preview (.nn-card) from an naddr reference.
   * Fetches the event, then dispatches it through the standard
   * FollowPackProcessor + FollowPackRenderer pipeline so the inline quote box
   * shows the same card as the timeline. Mirrors {@link renderListingPreview}.
   */
  public async renderFollowPackPreview(
    naddrRef: string,
    container: Element
  ): Promise<void> {
    try {
      const result =
        await this.quoteFetcher.fetchQuotedEventWithError(naddrRef);
      if (result.success && result.event.kind === 39089) {
        const el = await this.buildFollowPackElement(result.event);
        container.appendChild(el);
      }
    } catch {
      /* silent — container stays empty */
    }
  }

  /**
   * Build the follow-pack element via the standard Processor + Renderer pair.
   * Shared by the naddr quote path ({@link renderFollowPackPreview}) and the
   * fetched-quote addressable branch in {@link fetchAndRenderQuote}.
   */
  private async buildFollowPackElement(
    event: NostrEvent
  ): Promise<HTMLElement> {
    const { FollowPackProcessor } = await import(
      '../../../components/ui/note-processing/FollowPackProcessor'
    );
    const { FollowPackRenderer } = await import(
      '../../../components/ui/note-rendering/FollowPackRenderer'
    );
    const processedNote = FollowPackProcessor.process(event);
    return FollowPackRenderer.render(processedNote, {
      collapsible: false,
      depth: 1,
    });
  }

  /**
   * Render a compact listing card from a Kind 30402 event.
   * Reuses the core listing metadata helper (helpers/listingMetadata).
   */
  private async renderListingPreviewFromEvent(
    event: NostrEvent,
    container: Element
  ): Promise<void> {
    const { encodeNaddr } = await import('../../../services/NostrToolsAdapter');
    const { UserProfileService } = await import(
      '../../../services/UserProfileService'
    );
    const { hexToNpub } = await import('../../../helpers/nip19');
    const { escapeHtmlAttr } = await import('../../../helpers/escapeHtml');

    const meta = parseListingMetadata(event);
    const naddr = encodeNaddr({
      kind: 30402,
      pubkey: event.pubkey,
      identifier: meta.identifier,
      relays: [],
    });
    const priceDisplay = formatPrice(
      meta.price,
      meta.priceCurrency,
      meta.priceFrequency
    );
    const firstImage = meta.images[0] || '';

    const card = document.createElement('div');
    card.className = 'timeline-listing-card timeline-listing-card--quoted';
    card.style.cursor = 'pointer';
    card.innerHTML = `
      ${
        firstImage
          ? `
        <div class="timeline-listing-card__image">
          <img src="${escapeHtmlAttr(firstImage)}" alt="" loading="lazy" />
        </div>
      `
          : ''
      }
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

    card.addEventListener('click', e => {
      if (
        (e.target as HTMLElement).closest(
          '.note-image--clickable, .note-media, video'
        )
      )
        return;
      e.stopPropagation(); // Prevent parent note-card from navigating to SNV
      if ((e.target as HTMLElement).closest('.mention-link')) {
        e.preventDefault();
        const pubkey = (e.target as HTMLElement)
          .closest('[data-profile-pubkey]')
          ?.getAttribute('data-profile-pubkey');
        if (pubkey) {
          const npub = hexToNpub(pubkey);
          if (npub) Router.getInstance().navigate(`/profile/${npub}`);
        }
        return;
      }
      // Right-pane mode opens the listing in the secondary pane (scc).
      getViewNavigationController().openView('listing', naddr, e);
    });

    container.appendChild(card);

    // Async: load seller name
    try {
      const profile = await UserProfileService.getInstance().getUserProfile(
        event.pubkey
      );
      const linkEl = card.querySelector('.mention-link');
      if (linkEl) {
        linkEl.textContent =
          profile?.name ||
          profile?.display_name ||
          `${hexToNpub(event.pubkey)?.slice(0, 12)}...` ||
          '…';
      }
    } catch {
      /* keep placeholder */
    }
  }
}
