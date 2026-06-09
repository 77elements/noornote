/**
 * NoteStructureBuilder - Shared DOM structure builder
 * Builds common note structure (header, content, media, ISL)
 * Extracts from: NoteUI.buildNoteStructure()
 */

import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { encodeNevent, type Event as NostrEvent } from '../../../services/NostrToolsAdapter';
import { NoteHeader } from '../NoteHeader';
import { ThreadContextIndicator } from '../ThreadContextIndicator';
import { InteractionStatusLine } from '../InteractionStatusLine';
import { AnalyticsModal } from '../../analytics/AnalyticsModal';
import { AppState } from '../../../services/AppState';
import { replaceMediaPlaceholders } from '../../../helpers/renderMediaContent';
import { replaceBolt11Placeholders } from '../../../helpers/renderBolt11';
import { extractOriginalNoteId } from '../../../helpers/extractOriginalNoteId';
import { UserHoverCard } from '../UserHoverCard';
import { getViewNavigationController } from '../../../services/ViewNavigationController';
import { PerAccountLocalStorage, StorageKeys } from '../../../services/PerAccountLocalStorage';
import { ModuleLoader } from '../../../core/ModuleLoader';
import type { PostsModuleApi } from '../../../modules/posts/contracts';

// Component lifecycle is tied to the DOM node, never the note id: a card is
// cleaned up by walking its own subtree, so removing one card can never destroy
// another card that happens to share a note id (a note plus its repost, or a
// duplicate feed entry). Keyed by the structural note element built below.
interface NoteInstances {
  header: NoteHeader;
  isl?: InteractionStatusLine;
  islNoteId?: string;
}
const instancesByElement: WeakMap<HTMLElement, NoteInstances> = new WeakMap();

// Secondary index for by-id lookups only (SNV / replies push updated counts to
// an ISL after an async fetch). A Set, not a single slot, so a duplicate note id
// can never evict a live instance; getISLInstance returns the most recently
// registered one (preserves the previous last-wins behaviour). Mutated only in
// build() and cleanupElement(), so it stays in sync with instancesByElement.
const islByNoteId: Map<string, Set<InteractionStatusLine>> = new Map();

export interface NoteStructureBuildOptions {
  cssClass: string;
  footerLabel: string;
  renderQuotedNotes: boolean;
}

export interface NoteStructureResult {
  element: HTMLElement;
  noteHeader: NoteHeader;
}

export class NoteStructureBuilder {
  /**
   * Extract reply information (parent event ID + relay hint)
   * Uses NIP-10 convention with proper marker support
   */
  private static extractReplyInfo(event: NostrEvent): { parentEventId: string; relayHint: string | null } | null {
    // NIP-10: marker "mention" is citation, NOT reply parent. Filter them out
    // so legacy quote-reposts (Primal-iOS pre-NIP-18: e-tag marked "mention")
    // don't get the ThreadContextIndicator strip mounted at the top.
    const eTags = event.tags.filter(tag => tag[0] === 'e' && tag[3] !== 'mention');

    if (eTags.length > 0) {
      // NIP-10: Look for explicit "reply" marker
      const replyTag = eTags.find(tag => tag[3] === 'reply');
      let selectedTag: string[] | undefined;
      if (replyTag) {
        selectedTag = replyTag;
      } else if (eTags.length === 1) {
        // NIP-10 deprecated positional: if only one e-tag, it's the parent
        selectedTag = eTags[0];
      } else {
        // NIP-10 deprecated positional: if multiple, last is replied-to, first is root
        selectedTag = eTags[eTags.length - 1];
      }

      const parentEventId = selectedTag?.[1];
      if (selectedTag && parentEventId) {
        return {
          parentEventId,
          relayHint: selectedTag[2] || null
        };
      }
    }

    // Replies on addressable events (articles etc.) reference the parent via
    // 'a' tag, with no 'e' tag at all. Two conventions:
    //   - kind:1111 (NIP-22 comments) — formal spec, never uses markers; 'A'
    //     is root, 'a' is direct parent. Both are valid parent references.
    //   - kind:1   (legacy NIP-10 style used by Yakihonne, Highlighter, etc.)
    //     Only treat as a reply if the 'a' tag has an explicit "reply" or
    //     "root" marker. A bare 'a' tag on kind:1 most commonly comes from
    //     quote-posts (NIP-18 quote-with-tagging) which already render the
    //     parent inline in the body — adding the indicator would duplicate.
    if (event.kind === 1111) {
      const parentATag = event.tags.find(tag => tag[0] === 'a')
                      ?? event.tags.find(tag => tag[0] === 'A');
      if (parentATag?.[1]) {
        return {
          parentEventId: parentATag[1],
          relayHint: parentATag[2] || null
        };
      }
    } else if (event.kind === 1) {
      const parentATag = event.tags.find(tag => tag[0] === 'a' && tag[3] === 'reply')
                      ?? event.tags.find(tag => tag[0] === 'a' && tag[3] === 'root');
      if (parentATag?.[1]) {
        return {
          parentEventId: parentATag[1],
          relayHint: parentATag[2] || null
        };
      }
    }

    return null;
  }

  /**
   * Check if content is long and needs truncation
   */
  private static hasLongContent(content: string): boolean {
    return content.length > 500 || content.split('\n').length > 10;
  }

  /**
   * Get user preference for displaying NSFW content
   * Returns true if user wants to see NSFW content (no blur)
   * Returns false if user wants to hide NSFW content (blur)
   */
  private static getUserNSFWPreference(): boolean {
    try {
      const settings = PerAccountLocalStorage.getInstance().get<{ displayNSFW: boolean }>(StorageKeys.SENSITIVE_MEDIA, { displayNSFW: false });
      return settings.displayNSFW || false;
    } catch (error) {
      console.warn('Failed to load NSFW preference:', error);
    }
    return false; // Default: hide NSFW (blur)
  }

  /**
   * Build note structure (shared logic for quotes and originals)
   * Eliminates code duplication between createQuoteElement and createOriginalNoteElement
   */
  static build(
    note: ProcessedNote,
    buildOptions: NoteStructureBuildOptions,
    renderOptions: NoteUIOptions
  ): NoteStructureResult {
    const noteDiv = document.createElement('div');
    noteDiv.className = `note-card ${buildOptions.cssClass}`;
    noteDiv.dataset.eventId = note.id;

    // Register the raw event with the posts module so features that need a sync
    // event lookup by id (e.g. TextSelectionToolbar → highlight publishing)
    // can resolve it without re-fetching from relays.
    ModuleLoader.getInstance().getApi<PostsModuleApi>('posts')?.registerNote(note.rawEvent);

    // Create note header component
    const noteHeader = new NoteHeader({
      pubkey: note.author.pubkey,
      eventId: note.id,
      timestamp: note.timestamp,
      rawEvent: note.rawEvent,
      showVerification: true,
      showTimestamp: true,
      showMenu: true
    });

    // Check if this is a reply and extract parent event ID + relay hint
    // For reposts: ONLY check if we have the full reposted event (standard repost)
    // Skip for NIP-18 reposts (empty content) - their e-tags point to original, not a reply parent
    let replyInfo = null;
    if (note.type === 'repost') {
      // Only check reply info if we have the reposted event (standard format)
      replyInfo = note.repostedEvent ? NoteStructureBuilder.extractReplyInfo(note.repostedEvent) : null;
    } else {
      // For regular notes, check the raw event
      replyInfo = NoteStructureBuilder.extractReplyInfo(note.rawEvent);
    }

    // Check for long content
    const hasLong = NoteStructureBuilder.hasLongContent(note.content.text);
    const contentClass = hasLong ? 'event-content has-long-content' : 'event-content';

    // Build HTML structure (quotes are inline in processedHtml, no separate section needed)
    let processedHtml = note.content.html;

    // Check for content-warning tag (NIP-36 NSFW)
    const hasContentWarning = note.rawEvent.tags.some(tag => tag[0] === 'content-warning');

    // Load user preference for displaying NSFW
    const shouldBlurNSFW = !NoteStructureBuilder.getUserNSFWPreference();

    // Only blur if: (1) has content-warning tag AND (2) user wants blurring
    const isNSFW = hasContentWarning && shouldBlurNSFW;

    // Replace media placeholders with actual media (inline at original position)
    processedHtml = replaceMediaPlaceholders(
      processedHtml,
      note.content.media,
      isNSFW,
      note.rawEvent.id,
      note.rawEvent.pubkey
    );
    processedHtml = replaceBolt11Placeholders(processedHtml, note.content.bolt11Invoices);

    // Remove line breaks before quote markers (user pressed Enter before pasting quote)
    processedHtml = processedHtml.replace(/((<br\s*\/?>)\s*)+(?=<span class="quote-marker")/gi, '');

    noteDiv.innerHTML = `
      <div class="reply-indicator-container"></div>
      <div class="${contentClass}">${processedHtml}</div>
    `;

    // Mount note header as first child
    noteDiv.insertBefore(noteHeader.getElement(), noteDiv.firstChild);

    // Image click + video player are wired globally at app startup
    // (ImageClickHandler.init() / VideoPlayerService.init() in App.ts) so they
    // work for ANY .note-image--clickable / video.note-video regardless of
    // render path or nesting depth — no per-container init needed.

    // Initialize user hover card for all mention links
    const userHoverCard = UserHoverCard.getInstance();
    userHoverCard.initializeForMentions(noteDiv);

    // Mount thread context indicator if this is a reply
    if (replyInfo) {
      const replyIndicatorContainer = noteDiv.querySelector('.reply-indicator-container');
      if (replyIndicatorContainer) {
        // For reposts, use the original event ID for thread context
        const contextNoteId = (note.type === 'repost' && note.repostedEvent?.id)
          ? note.repostedEvent.id
          : note.id;

        const threadContextIndicator = new ThreadContextIndicator({
          noteId: contextNoteId
        });
        replyIndicatorContainer.appendChild(threadContextIndicator.getElement());
      }
    }

    // Mount ISL as direct sibling (no container)
    // For reposts, use the original event ID and author for stats (reposts reference original note)
    const islNoteId = extractOriginalNoteId(note.rawEvent);

    // Only render ISL if we have a valid note ID
    let islInstance: InteractionStatusLine | undefined;
    if (islNoteId) {
      const islAuthorPubkey = note.author.pubkey; // For reposts, this is already the original author

      const isl = new InteractionStatusLine({
        noteId: islNoteId,
        authorPubkey: islAuthorPubkey,
        originalEvent: note.rawEvent, // Pass original event for reposting
        fetchStats: renderOptions.islFetchStats || false,
        isLoggedIn: renderOptions.isLoggedIn || false,
        onAnalytics: () => {
          // Save ProfileView scroll position BEFORE opening modal
          const profileView = document.querySelector('.profile-view') as HTMLElement;

          if (profileView) {
            const scrollPosition = profileView.scrollTop;
            const appState = AppState.getInstance();
            appState.setState('view', { profileScrollPosition: scrollPosition });
          }

          // Open Analytics Modal
          const analyticsModal = AnalyticsModal.getInstance();
          analyticsModal.show(islNoteId, note.rawEvent);
        }
      });
      noteDiv.appendChild(isl.getElement());
      islInstance = isl;
    }

    // Add click handler to navigate to Single Note View
    noteDiv.addEventListener('mousedown', (e) => {
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
        target.closest('.quote-box') ||
        target.closest('.article-preview-card') ||
        target.closest('.timeline-listing-card') ||
        target.closest('.reply-indicator') ||
        target.closest('.thread-context-indicator')
      ) {
        return;
      }

      // Navigate to Single Note View.
      const nevent = encodeNevent(note.id);
      const navController = getViewNavigationController();
      navController.openView('single-note', nevent, e);
    });

    // Register lifecycle against the DOM node (see instancesByElement above).
    const instances: NoteInstances = { header: noteHeader };
    if (islInstance && islNoteId) {
      instances.isl = islInstance;
      instances.islNoteId = islNoteId;
      let set = islByNoteId.get(islNoteId);
      if (!set) {
        set = new Set();
        islByNoteId.set(islNoteId, set);
      }
      set.add(islInstance);
    }
    instancesByElement.set(noteDiv, instances);

    return { element: noteDiv, noteHeader };
  }

  /**
   * Most recently registered ISL instance for a note id. Used by SNV / replies
   * to push updated counts after an async fetch. Returns the latest registration
   * so an open SNV (mounted after the timeline) wins, matching prior behaviour.
   */
  static getISLInstance(noteId: string): InteractionStatusLine | undefined {
    const set = islByNoteId.get(noteId);
    if (!set || set.size === 0) return undefined;
    let last: InteractionStatusLine | undefined;
    for (const isl of set) last = isl;
    return last;
  }

  /**
   * Destroy the header/ISL instances for every note element inside `root`
   * (including `root` itself). Scoped to the DOM subtree being removed, so a
   * card that shares a note id with another, still-visible card is never
   * touched — this is what stops the ISL from vanishing on a sibling card.
   */
  static cleanupElement(root: HTMLElement): void {
    const elements: HTMLElement[] = [];
    if (root.classList?.contains('note-card')) elements.push(root);
    root.querySelectorAll<HTMLElement>('.note-card').forEach(el => elements.push(el));

    for (const el of elements) {
      const instances = instancesByElement.get(el);
      if (!instances) continue;

      instances.header.destroy();
      if (instances.isl) {
        instances.isl.destroy();
        if (instances.islNoteId) {
          const set = islByNoteId.get(instances.islNoteId);
          if (set) {
            set.delete(instances.isl);
            if (set.size === 0) islByNoteId.delete(instances.islNoteId);
          }
        }
      }
      instancesByElement.delete(el);
    }
  }

  /**
   * Cleanup every note element within `container` (defaults to the whole
   * document). Used on view teardown / account switch.
   */
  static cleanupAll(container?: HTMLElement): void {
    NoteStructureBuilder.cleanupElement(container ?? document.body);
  }
}
