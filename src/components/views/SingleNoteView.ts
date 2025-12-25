/**
 * SingleNoteView Component
 * Displays a single note with full content using NoteUI (unified rendering)
 * Single Source of Truth: NoteUI handles all note rendering
 */

import { View } from './View';
import { NoteUI } from '../ui/NoteUI';
import { ZapsList } from '../ui/ZapsList';
import { LikesList } from '../ui/LikesList';
import { ThreadManager } from './managers/ThreadManager';
import { LiveUpdatesManager } from './managers/LiveUpdatesManager';
import { fetchNostrEvents } from '../../helpers/fetchNostrEvents';
import { RelayConfig } from '../../services/RelayConfig';
import { ThreadOrchestrator } from '../../services/orchestration/ThreadOrchestrator';
import { ReactionsOrchestrator } from '../../services/orchestration/ReactionsOrchestrator';
import { UserProfileService } from '../../services/UserProfileService';
import { AuthService } from '../../services/AuthService';
import { extractOriginalNoteId } from '../../helpers/extractOriginalNoteId';
import { SystemLogger } from '../system/SystemLogger';
import { AppState } from '../../services/AppState';
import { Router } from '../../services/Router';
import { EventBus } from '../../services/EventBus';
import { decodeNip19, encodeNpub } from '../../services/NostrToolsAdapter';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

export class SingleNoteView extends View {
  private container: HTMLElement;
  private noteId: string;
  private relayConfig: RelayConfig;
  private threadOrchestrator: ThreadOrchestrator;
  private reactionsOrchestrator: ReactionsOrchestrator;
  private authService: AuthService;
  private systemLogger: SystemLogger;
  private appState: AppState;
  private router: Router;
  private eventBus: EventBus;
  private currentNoteId: string | null = null;
  private currentEvent: NostrEvent | null = null;

  // Managers
  private threadManager?: ThreadManager;
  private liveUpdatesManager?: LiveUpdatesManager;

  // EventBus unsubscribe functions
  private muteUpdatedUnsubscribe?: () => void;

  constructor(noteId: string) {
    super(); // Call View base class constructor
    this.noteId = noteId;
    this.container = document.createElement('div');
    this.container.className = 'snv-container';
    this.relayConfig = RelayConfig.getInstance();
    this.threadOrchestrator = ThreadOrchestrator.getInstance();
    this.reactionsOrchestrator = ReactionsOrchestrator.getInstance();
    this.authService = AuthService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.appState = AppState.getInstance();
    this.router = Router.getInstance();
    this.eventBus = EventBus.getInstance();

    // Reset ISL fetch counter for new SNV session
    this.reactionsOrchestrator.resetFetchCounter();

    // Listen for mute events
    this.setupMuteListener();

    this.render();
  }

  /**
   * Initial render - show loading, then load note
   */
  private async render(): Promise<void> {
    // Show loading state
    this.container.innerHTML = `
      <div class="snv-loading">
        <div class="loading-spinner"></div>
        <p>Loading note...</p>
      </div>
    `;

    try {
      // Decode nevent/note ID
      const actualNoteId = this.decodeNoteId(this.noteId);

      // Fetch the note
      const event = await this.fetchNote(actualNoteId);

      if (!event) {
        this.showError('Note not found');
        return;
      }

      this.renderNote(event);
    } catch (_error) {
      this.systemLogger.error('SNV', `❌ Failed to load note: ${_error}`);
      this.showError('Failed to load note');
    }
  }

  /**
   * Decode nevent/note/hex ID to actual note ID
   */
  private decodeNoteId(noteId: string): string {
    if (noteId.startsWith('nevent1')) {
      const decoded = decodeNip19(noteId);
      if (decoded.type === 'nevent') {
        return decoded.data.id;
      }
    } else if (noteId.startsWith('note1')) {
      const decoded = decodeNip19(noteId);
      if (decoded.type === 'note') {
        return decoded.data as string;
      }
    }

    // Assume it's already a hex ID
    return noteId;
  }

  /**
   * Fetch note from relays
   */
  private async fetchNote(noteId: string): Promise<NostrEvent | null> {
    // Get read relays from config
    const relays = this.relayConfig.getReadRelays();

    // Fetch by ID
    const result = await fetchNostrEvents({
      relays,
      ids: [noteId],
      limit: 1
    });

    if (result.events.length === 0) {
      this.systemLogger.warn('SNV', `⚠️ Note not found (${noteId.slice(0, 8)})`);
      return null;
    }

    const event = result.events[0];

    // For reposts (kind 6), extract original author from p-tags
    let authorPubkey = event.pubkey;
    if (event.kind === 6) {
      const pTags = event.tags.filter(tag => tag[0] === 'p');
      if (pTags.length > 0) {
        authorPubkey = pTags[0][1]; // Original author is first p-tag
      }
    }

    // Get author username (from cache if available, otherwise fetch)
    const profileService = UserProfileService.getInstance();
    const username = profileService.getUsername(authorPubkey);

    // Truncate username if too long (or use fallback if not cached yet)
    const displayName = username
      ? (username.length > 10 ? username.substring(0, 10) + '..' : username)
      : 'User';

    this.systemLogger.info('SNV', `📄 Fetching ${displayName}'s note (${noteId.slice(0, 8)})...`);

    return event;
  }

  /**
   * Render the loaded note using NoteUI (unified with Timeline/Profile)
   */
  private async renderNote(event: NostrEvent): Promise<void> {
    // Check if this is a repost (kind 6)
    // SNV should display the reposted note directly, not the repost wrapper
    if (event.kind === 6) {
      const originalNoteId = extractOriginalNoteId(event);

      // Fetch the original note
      const originalEvent = await this.fetchNote(originalNoteId);

      if (!originalEvent) {
        this.showError('Original note not found');
        return;
      }

      // Render the original note instead of the repost
      event = originalEvent;
    }

    // Clear loading state
    this.container.innerHTML = '';

    // Check if user is logged in (interactions require authentication)
    const isUserLoggedIn = this.authService.getCurrentUser() !== null;

    // Use NoteUI for consistent rendering (Single Source of Truth!)
    const noteElement = NoteUI.createNoteElement(event, {
      collapsible: false,       // SNV shows full note (no "Show More")
      islFetchStats: true,      // SNV fetches stats from relays
      isLoggedIn: isUserLoggedIn, // Enable interactions only if logged in
      headerSize: 'large',      // SNV uses large header
      depth: 0
    });

    // Add SNV-specific wrapper
    const snvWrapper = document.createElement('div');
    snvWrapper.className = 'snv-wrapper';

    // Add SNV-specific containers
    const repliesContainer = document.createElement('div');
    repliesContainer.className = 'snv-replies-container';

    const footer = this.createFooter();

    snvWrapper.appendChild(noteElement);
    snvWrapper.appendChild(repliesContainer);
    snvWrapper.appendChild(footer);

    this.container.appendChild(snvWrapper);

    // Store current note and ID for cleanup and mute checks
    this.currentNoteId = event.id;
    this.currentEvent = event;

    // Initialize managers
    this.initializeManagers(event.id, event.pubkey, repliesContainer);

    // Fetch and render zaps list
    this.loadZapsList(event.id, event.pubkey, noteElement);

    // Fetch and render replies using ThreadManager
    if (this.threadManager) {
      const quotedReposts = await this.threadManager.fetchQuotedReposts();
      await this.threadManager.loadReplies(quotedReposts);
    }

    // Start live updates using manager
    if (this.liveUpdatesManager) {
      this.liveUpdatesManager.startLiveUpdates();
    }
  }

  /**
   * Initialize managers for thread and live updates
   */
  private initializeManagers(noteId: string, noteAuthor: string, _repliesContainer: HTMLElement): void {
    // Initialize ThreadManager
    this.threadManager = new ThreadManager({
      noteId,
      noteAuthor,
      container: this.container,
      onStatsUpdate: (replies, quotedReposts) => {
        const isl = NoteUI.getInteractionStatusLine(noteId);
        if (isl) {
          isl.waitForInitialFetch().then(() => {
            isl.updateStats({ replies, quotedReposts });
            this.reactionsOrchestrator.updateCachedStats(noteId, { replies, quotedReposts });
          });
        }
      },
      onLoadZapsList: (replyId, authorPubkey, element) => {
        this.loadZapsList(replyId, authorPubkey, element);
      }
    });

    // Initialize LiveUpdatesManager
    this.liveUpdatesManager = new LiveUpdatesManager({
      noteId,
      onLiveReply: (reply) => {
        if (this.threadManager) {
          this.threadManager.appendLiveReply(reply);
        }
      },
      onStatsUpdate: (stats) => {
        const isl = NoteUI.getInteractionStatusLine(noteId);
        if (isl) {
          isl.updateStats(stats);
        }
      },
      onZapAdded: (targetNoteId) => {
        const noteElement = this.container.querySelector(`[data-note-id="${targetNoteId}"]`);
        if (noteElement instanceof HTMLElement) {
          const authorPubkey = noteElement.getAttribute('data-author-pubkey');
          if (authorPubkey) {
            this.loadZapsList(targetNoteId, authorPubkey, noteElement);
          }
        }
      },
      onMuteUpdated: () => {
        this.render();
      },
      onNoteDeleted: () => {
        this.router.navigate('/timeline');
      }
    });
  }

  /**
   * Load and render likes list and zaps list above ISL
   */
  private async loadZapsList(noteId: string, authorPubkey: string, noteElement: HTMLElement): Promise<void> {
    try {
      // Fetch detailed stats to get zap and reaction events
      const stats = await this.reactionsOrchestrator.getDetailedStats(noteId);

      // Find ISL container (we'll insert above it)
      const islContainer = noteElement.querySelector('.isl');
      if (!islContainer || !islContainer.parentNode) return;

      // Remove existing lists if present (for refresh)
      const existingZapsList = noteElement.querySelector('.zaps-list');
      const existingLikesList = noteElement.querySelector('.likes-list');
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
   * Create footer with Back button(s)
   */
  private createFooter(): HTMLElement {
    const footer = document.createElement('div');
    footer.className = 'snv-footer';

    // Check if we came from search results
    const searchState = this.appState.getState('profileSearch');
    const cameFromSearch = searchState.navigatedToSNV && searchState.isActive;

    if (cameFromSearch && searchState.pubkeyHex) {
      // Show "Back to Search Results" button
      const backToSearchBtn = document.createElement('button');
      backToSearchBtn.className = 'btn btn--medium btn--passive';
      backToSearchBtn.textContent = '← Back to Search Results';
      backToSearchBtn.addEventListener('click', () => {
        // Clear navigatedToSNV flag
        this.appState.setState('profileSearch', { navigatedToSNV: false });

        // Navigate back to profile with npub
        const npub = encodeNpub(searchState.pubkeyHex);
        this.router.navigate(`/profile/${npub}`);
      });
      footer.appendChild(backToSearchBtn);
    } else {
      // Show regular "Back" button
      const backBtn = document.createElement('button');
      backBtn.className = 'btn btn--medium btn--passive';
      backBtn.textContent = '← Back';
      backBtn.addEventListener('click', () => {
        history.back();
      });
      footer.appendChild(backBtn);
    }

    return footer;
  }

  /**
   * Show error message
   */
  private showError(message: string): void {
    this.container.innerHTML = `
      <div class="snv-error">
        <div class="snv-error__icon">⚠️</div>
        <div class="snv-error__message">${message}</div>
        <button class="btn btn--medium btn--passive" onclick="history.back()">← Back</button>
      </div>
    `;
  }

  /**
   * Get the DOM element
   */
  public getElement(): HTMLElement {
    return this.container;
  }


  /**
   * Setup listener for mute updates - navigate away if viewed note author is muted
   */
  private setupMuteListener(): void {
    this.muteUpdatedUnsubscribe = this.eventBus.on('mute:updated', (data?: { pubkey?: string }) => {
      // Navigate to timeline if viewing the muted user's note
      // Note: data.pubkey may be undefined for bulk mute operations
      if (data?.pubkey && this.currentEvent && this.currentEvent.pubkey === data.pubkey) {
        this.router.navigate('/');
      }
      // Note: Muted user's replies remain visible until manual page refresh
      // (ThreadManager.loadReplies() requires quotedReposts parameter, not suitable for refresh)
    });
  }

  /**
   * Cleanup resources
   */
  public destroy(): void {
    // Unsubscribe from EventBus
    if (this.muteUpdatedUnsubscribe) {
      this.eventBus.off(this.muteUpdatedUnsubscribe);
    }

    // Cleanup managers
    if (this.liveUpdatesManager) {
      this.liveUpdatesManager.destroy();
    }

    // Stop all live updates (CRITICAL!)
    if (this.currentNoteId) {
      this.systemLogger.info('SNV', `🔴 Stopping live updates for note ${this.currentNoteId.slice(0, 8)}`);
      this.threadOrchestrator.stopLiveReplies(this.currentNoteId);
      this.reactionsOrchestrator.stopLiveReactions(this.currentNoteId);
    }

    // NoteUI handles its own cleanup
    this.container.remove();
  }
}
