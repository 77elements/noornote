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
import { Router } from '../../../services/Router';
import { replaceMediaPlaceholders } from '../../../helpers/renderMediaContent';
import { extractOriginalNoteId } from '../../../helpers/extractOriginalNoteId';
import { getImageClickHandler } from '../../../services/ImageClickHandler';
import { getVideoPlayerService } from '../../../services/VideoPlayerService';
import { UserHoverCard } from '../UserHoverCard';
import { getViewNavigationController } from '../../../services/ViewNavigationController';

// Store component instances for cleanup
const noteHeaderInstances: Map<string, NoteHeader> = new Map();
const islInstances: Map<string, InteractionStatusLine> = new Map();

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
    const eTags = event.tags.filter(tag => tag[0] === 'e');
    if (eTags.length === 0) return null;

    let selectedTag: string[] | null = null;

    // NIP-10: Look for explicit "reply" marker
    const replyTag = eTags.find(tag => tag[3] === 'reply');
    if (replyTag) {
      selectedTag = replyTag;
    } else if (eTags.length === 1) {
      // NIP-10 deprecated positional: if only one e-tag, it's the parent
      selectedTag = eTags[0];
    } else {
      // NIP-10 deprecated positional: if multiple, last is replied-to, first is root
      selectedTag = eTags[eTags.length - 1];
    }

    return {
      parentEventId: selectedTag[1],
      relayHint: selectedTag[2] || null
    };
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
      const stored = localStorage.getItem('noornote_sensitive_media');
      if (stored) {
        const settings = JSON.parse(stored);
        return settings.displayNSFW || false;
      }
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

    // Create note header component
    const noteHeader = new NoteHeader({
      pubkey: note.author.pubkey,
      eventId: note.id,
      timestamp: note.timestamp,
      rawEvent: note.rawEvent,
      size: renderOptions.headerSize || 'medium',
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

    // Remove line breaks before quote markers (user pressed Enter before pasting quote)
    processedHtml = processedHtml.replace(/((<br\s*\/?>)\s*)+(?=<span class="quote-marker")/gi, '');

    noteDiv.innerHTML = `
      <div class="event-header-container"></div>
      <div class="reply-indicator-container"></div>
      <div class="${contentClass}">${processedHtml}</div>
    `;

    // Initialize image click handlers for full-screen viewer
    const imageClickHandler = getImageClickHandler();
    imageClickHandler.initializeForContainer(noteDiv);

    // Initialize Plyr video players
    const videoPlayerService = getVideoPlayerService();
    videoPlayerService.initializeForContainer(noteDiv);

    // Initialize user hover card for all mention links
    const userHoverCard = UserHoverCard.getInstance();
    userHoverCard.initializeForMentions(noteDiv);

    // Mount note header
    const headerContainer = noteDiv.querySelector('.event-header-container');
    if (headerContainer) {
      headerContainer.appendChild(noteHeader.getElement());
    }

    // Mount thread context indicator if this is a reply
    if (replyInfo) {
      const replyIndicatorContainer = noteDiv.querySelector('.reply-indicator-container');
      if (replyIndicatorContainer) {
        // For reposts, use the original event ID for thread context
        const contextNoteId = (note.type === 'repost' && note.repostedEvent)
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
          console.log(`📍 NoteStructureBuilder: Saving ProfileView scroll before Analytics modal: ${scrollPosition}px`);
          const appState = AppState.getInstance();
          appState.setState('view', { profileScrollPosition: scrollPosition });
        }

        // Open Analytics Modal
        const analyticsModal = AnalyticsModal.getInstance();
        analyticsModal.show(islNoteId, note.rawEvent);
      }
    });
    noteDiv.appendChild(isl.getElement());
    islInstances.set(islNoteId, isl);

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
        target.closest('.quote-box') ||
        target.closest('.reply-indicator')
      ) {
        return;
      }

      // Navigate to Single Note View via ViewNavigationController
      const navController = getViewNavigationController();
      const nevent = encodeNevent(note.id);
      navController.openView('single-note', nevent, e);
    });

    // Store header reference
    noteHeaderInstances.set(note.id, noteHeader);

    return { element: noteDiv, noteHeader };
  }

  /**
   * Get stored component instances (for cleanup)
   */
  static getHeaderInstance(noteId: string): NoteHeader | undefined {
    return noteHeaderInstances.get(noteId);
  }

  static getISLInstance(noteId: string): InteractionStatusLine | undefined {
    return islInstances.get(noteId);
  }

  /**
   * Cleanup stored instances
   */
  static cleanup(noteId: string): void {
    noteHeaderInstances.delete(noteId);

    const isl = islInstances.get(noteId);
    if (isl) {
      isl.destroy();
      islInstances.delete(noteId);
    }
  }

  static cleanupAll(): void {
    noteHeaderInstances.clear();
    islInstances.forEach(isl => isl.destroy());
    islInstances.clear();
  }
}
