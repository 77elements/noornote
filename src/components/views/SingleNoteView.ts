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
import { ModuleLoader } from '../../core/ModuleLoader';
import type { SingleNoteModuleApi } from '../../modules/single-note/contracts';
import type { ReactionsModuleApi } from '../../modules/reactions/contracts';
import { LongFormOrchestrator } from '../../services/orchestration/LongFormOrchestrator';
import { UserProfileService } from '../../services/UserProfileService';
import { AuthService } from '../../services/AuthService';
import { extractOriginalNoteId } from '../../helpers/extractOriginalNoteId';
import { SystemLogger } from '../../services/SystemLogger';
import { AppState } from '../../services/AppState';
import { Router } from '../../services/Router';
import { EventBus } from '../../services/EventBus';
import { decodeNip19, encodeNpub } from '../../services/NostrToolsAdapter';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

export class SingleNoteView extends View {
  private container: HTMLElement;
  private noteId: string;
  private relayConfig: RelayConfig;
  private singleNoteApi: SingleNoteModuleApi | null;
  private reactionsApi: ReactionsModuleApi | null;
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

  // EventBus subscription IDs
  private muteUpdatedSubscriptionId?: string;

  constructor(noteId: string) {
    super();
    this.noteId = noteId;
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--single-note';
    this.relayConfig = RelayConfig.getInstance();
    this.singleNoteApi = ModuleLoader.getInstance().getApi<SingleNoteModuleApi>('single-note');
    this.reactionsApi = ModuleLoader.getInstance().getApi<ReactionsModuleApi>('reactions');
    this.authService = AuthService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.appState = AppState.getInstance();
    this.router = Router.getInstance();
    this.eventBus = EventBus.getInstance();

    this.reactionsApi?.resetFetchCounter();
    this.setupMuteListener();
    this.render();
  }

  private async render(): Promise<void> {
    this.container.innerHTML = `
      <div class="snv-loading">
        <div class="loading-spinner"></div>
        <p>Loading note...</p>
      </div>
    `;

    try {
      const event = this.noteId.startsWith('naddr1')
        ? await this.fetchAddressable(this.noteId)
        : await this.fetchNote(this.decodeNoteId(this.noteId));

      if (!event) {
        this.showError('Note not found');
        return;
      }

      this.renderNote(event);
    } catch (error) {
      this.systemLogger.error('SNV', `Failed to load note: ${error}`);
      this.showError('Failed to load note');
    }
  }

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
    return noteId;
  }

  private async fetchAddressable(naddrRef: string): Promise<NostrEvent | null> {
    const event = await LongFormOrchestrator.getInstance().fetchAddressableEvent(naddrRef);
    if (!event) {
      this.systemLogger.warn('SNV', `Note not found (${naddrRef.slice(0, 16)}…)`);
      return null;
    }
    const username = UserProfileService.getInstance().getUsername(event.pubkey);
    const displayName = username
      ? (username.length > 10 ? username.substring(0, 10) + '..' : username)
      : 'User';
    this.systemLogger.info('SNV', `Fetching ${displayName}'s note (${naddrRef.slice(0, 16)}…)...`);
    return event;
  }

  private async fetchNote(noteId: string): Promise<NostrEvent | null> {
    const relays = this.relayConfig.getReadRelays();

    const result = await fetchNostrEvents({
      relays,
      ids: [noteId],
      limit: 1
    });

    if (result.events.length === 0) {
      this.systemLogger.warn('SNV', `Note not found (${noteId.slice(0, 8)})`);
      return null;
    }

    const event = result.events[0];
    if (!event) {
      this.systemLogger.warn('SNV', `Note not found (${noteId.slice(0, 8)})`);
      return null;
    }

    let authorPubkey = event.pubkey;
    if (event.kind === 6) {
      const pTag = event.tags.find(tag => tag[0] === 'p');
      if (pTag?.[1]) authorPubkey = pTag[1];
    }

    const profileService = UserProfileService.getInstance();
    const username = profileService.getUsername(authorPubkey);
    const displayName = username
      ? (username.length > 10 ? username.substring(0, 10) + '..' : username)
      : 'User';

    this.systemLogger.info('SNV', `Fetching ${displayName}'s note (${noteId.slice(0, 8)})...`);

    return event;
  }

  private async renderNote(event: NostrEvent): Promise<void> {
    if (event.kind === 6) {
      const originalNoteId = extractOriginalNoteId(event);
      if (!originalNoteId) {
        this.showError('Could not extract original note ID from repost');
        return;
      }
      const originalEvent = await this.fetchNote(originalNoteId);

      if (!originalEvent) {
        this.showError('Original note not found');
        return;
      }

      event = originalEvent;
    }

    this.container.innerHTML = '';

    // Accessibility: Page heading for screen readers
    const pageHeading = document.createElement('h1');
    pageHeading.className = 'visually-hidden';
    pageHeading.textContent = 'Single Post';
    this.container.appendChild(pageHeading);

    const isUserLoggedIn = this.authService.getCurrentUser() !== null;

    const noteElement = NoteUI.createNoteElement(event, {
      collapsible: false,
      islFetchStats: true,
      isLoggedIn: isUserLoggedIn,
      headerSize: 'large',
      depth: 0
    });

    const snvWrapper = document.createElement('div');
    snvWrapper.className = 'snv-wrapper';

    const repliesContainer = document.createElement('div');
    repliesContainer.className = 'snv-replies-container';

    snvWrapper.appendChild(noteElement);
    snvWrapper.appendChild(repliesContainer);
    snvWrapper.appendChild(this.createFooter());

    this.container.appendChild(snvWrapper);

    const eventId = event.id;
    const eventPubkey = event.pubkey;
    if (!eventId || !eventPubkey) return;

    this.currentNoteId = eventId;
    this.currentEvent = event;

    this.initializeManagers(eventId, eventPubkey, repliesContainer);
    this.loadZapsList(eventId, eventPubkey, noteElement);

    if (this.threadManager) {
      const quotedReposts = await this.threadManager.fetchQuotedReposts();
      await this.threadManager.loadReplies(quotedReposts);
    }

    this.liveUpdatesManager?.startLiveUpdates();
  }

  private initializeManagers(noteId: string, noteAuthor: string, _repliesContainer: HTMLElement): void {
    // Cleanup existing manager before creating new one (prevents listener leaks on re-render)
    this.liveUpdatesManager?.destroy();

    this.threadManager = new ThreadManager({
      noteId,
      noteAuthor,
      container: this.container,
      onStatsUpdate: (replies, quotedReposts) => {
        const isl = NoteUI.getInteractionStatusLine(noteId);
        isl?.waitForInitialFetch().then(() => {
          isl.updateStats({ replies, quotedReposts });
          this.reactionsApi?.updateCachedStats(noteId, { replies, quotedReposts });
        });
      },
      onLoadZapsList: (replyId, authorPubkey, element) => {
        this.loadZapsList(replyId, authorPubkey, element);
      }
    });

    this.liveUpdatesManager = new LiveUpdatesManager({
      noteId,
      onLiveReply: (reply) => this.threadManager?.appendLiveReply(reply),
      onStatsUpdate: (stats) => NoteUI.getInteractionStatusLine(noteId)?.updateStats(stats),
      onZapAdded: (targetNoteId) => {
        const noteElement = this.container.querySelector(`[data-note-id="${targetNoteId}"]`);
        if (noteElement instanceof HTMLElement) {
          const authorPubkey = noteElement.getAttribute('data-author-pubkey');
          if (authorPubkey) {
            this.loadZapsList(targetNoteId, authorPubkey, noteElement);
          }
        }
      },
      onMuteUpdated: () => this.render(),
      onNoteDeleted: () => this.router.navigate('/timeline')
    });
  }

  private async loadZapsList(noteId: string, authorPubkey: string, noteElement: HTMLElement): Promise<void> {
    try {
      const stats = await this.reactionsApi?.getDetailedStats(noteId);
      if (!stats) return;

      const islContainer = noteElement.querySelector('.isl');
      if (!islContainer?.parentNode) return;

      noteElement.querySelector('.zaps-list')?.remove();
      noteElement.querySelector('.likes-list')?.remove();

      if (stats.zapEvents.length > 0) {
        const zapsList = new ZapsList(stats.zapEvents);
        islContainer.parentNode.insertBefore(zapsList.getElement(), islContainer);
      }

      if (stats.reactionEvents.length > 0) {
        const likesList = new LikesList(stats.reactionEvents, noteId, authorPubkey);
        await likesList.init();
        islContainer.parentNode.insertBefore(likesList.getElement(), islContainer);
      }
    } catch (error) {
      console.warn('Failed to load zaps/likes list:', error);
    }
  }

  private createBackButton(text: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'btn btn--medium btn--passive';
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    return btn;
  }

  private createFooter(): HTMLElement {
    const footer = document.createElement('div');
    footer.className = 'snv-footer';

    const searchState = this.appState.getState('profileSearch');
    const cameFromSearch = searchState.navigatedToSNV && searchState.isActive;

    const pubkeyHex = searchState.pubkeyHex;
    if (cameFromSearch && pubkeyHex) {
      footer.appendChild(this.createBackButton('← Back to Search Results', () => {
        this.appState.setState('profileSearch', { navigatedToSNV: false });
        const npub = encodeNpub(pubkeyHex);
        this.router.navigate(`/profile/${npub}`);
      }));
    } else {
      footer.appendChild(this.createBackButton('← Back', () => history.back()));
    }

    return footer;
  }

  private showError(message: string): void {
    this.container.innerHTML = `
      <div class="snv-error">
        <div class="snv-error__icon">!</div>
        <div class="snv-error__message">${message}</div>
        <button class="btn btn--medium btn--passive" onclick="history.back()">← Back</button>
      </div>
    `;
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  private setupMuteListener(): void {
    this.muteUpdatedSubscriptionId = this.eventBus.on('mute:updated', (data?: { pubkey?: string }) => {
      if (data?.pubkey && this.currentEvent?.pubkey === data.pubkey) {
        this.router.navigate('/');
      }
    });
  }

  public destroy(): void {
    if (this.muteUpdatedSubscriptionId) {
      this.eventBus.off(this.muteUpdatedSubscriptionId);
    }

    this.liveUpdatesManager?.destroy();

    if (this.currentNoteId) {
      this.systemLogger.info('SNV', `Stopping live updates for note ${this.currentNoteId.slice(0, 8)}`);
      this.singleNoteApi?.stopLiveReplies(this.currentNoteId);
      this.reactionsApi?.stopLiveReactions(this.currentNoteId);
    }

    this.container.remove();
  }
}
