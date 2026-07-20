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
import type { ArticlesModuleApi } from '../../modules/articles/contracts';
import { UserProfileService } from '../../services/UserProfileService';
import { AuthService } from '../../services/AuthService';
import { getRepostsOriginalEvent } from '../../helpers/getRepostsOriginalEvent';
import { resolveAddressableFromReferences } from '../../helpers/resolveAddressableFromReferences';
import { extractOriginalNoteId } from '../../helpers/extractOriginalNoteId';
import { SystemLogger } from '../../services/SystemLogger';
import { AppState } from '../../services/AppState';
import { Router } from '../../services/Router';
import { TypedEventBus } from '../../core/TypedEventBus';
import { decodeNip19, encodeNpub, encodeNevent } from '../../services/NostrToolsAdapter';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

export class SingleNoteView extends View {
  private container: HTMLElement;
  private noteId: string;
  private relayConfig: RelayConfig;
  private _singleNoteApi?: SingleNoteModuleApi | null;
  private get singleNoteApi(): SingleNoteModuleApi | null {
    return this._singleNoteApi ??= ModuleLoader.getInstance().getApi<SingleNoteModuleApi>('single-note');
  }
  private _reactionsApi?: ReactionsModuleApi | null;
  private get reactionsApi(): ReactionsModuleApi | null {
    return this._reactionsApi ??= ModuleLoader.getInstance().getApi<ReactionsModuleApi>('reactions');
  }
  private authService: AuthService;
  private systemLogger: SystemLogger;
  private appState: AppState;
  private router: Router;
  private eventBus: TypedEventBus;
  private currentNoteId: string | null = null;
  private currentEvent: NostrEvent | null = null;

  // Managers
  private threadManager?: ThreadManager;
  private liveUpdatesManager?: LiveUpdatesManager;

  // TypedEventBus subscription IDs
  private muteUpdatedSubscriptionId?: string;

  constructor(noteId: string) {
    super();
    this.noteId = noteId;
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--single-note';
    this.relayConfig = RelayConfig.getInstance();
    this.authService = AuthService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.appState = AppState.getInstance();
    this.router = Router.getInstance();
    this.eventBus = TypedEventBus.getInstance();

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

      if (event && !this.noteId.startsWith('naddr1')) {
        this.canonicalizeUrl(this.decodeNoteId(this.noteId));
      }

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

  /**
   * Normalise the address-bar URL to the one canonical /note/<nevent> form for this
   * note. Whether it was opened as /note/<hex> (notifications) or a relay-hinted
   * nevent (threads, search, bookmarks), the URL collapses to a single deterministic
   * entry — so Back leaves the note instead of stepping through duplicate encodings.
   * Only touches the primary (pathname) view; scc note tabs manage their own URL.
   */
  private canonicalizeUrl(hexId: string): void {
    if (!window.location.pathname.startsWith('/note/')) return;
    try {
      const canonical = `/note/${encodeNevent(hexId)}`;
      if (this.router.getCurrentPath() !== canonical) {
        this.router.replaceUrl(canonical);
      }
    } catch {
      // Encoding failed — leave the URL untouched.
    }
  }

  private async fetchAddressable(naddrRef: string): Promise<NostrEvent | null> {
    const articlesApi = ModuleLoader.getInstance().getApi<ArticlesModuleApi>('articles');
    const event = await articlesApi?.fetchAddressableEvent(naddrRef) ?? null;
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
    // Cache-first: a note already loaded by a feed (e.g. the Bulk Delete list, or
    // the timeline) resolves instantly from the NoteService LRU and doesn't depend
    // on the read relays still carrying it — old notes often aren't there anymore.
    let event: NostrEvent | null = this.singleNoteApi?.getCachedNote(noteId) ?? null;

    if (!event) {
      const result = await fetchNostrEvents({
        relays: this.relayConfig.getReadRelays(),
        ids: [noteId],
        limit: 1
      });
      event = result.events[0] ?? null;
    }

    // Fallback for replaceable events (NIP-33, kinds 30000–39999): the original
    // event id often no longer exists on relays because the author published an
    // updated version under the same coordinate. Look up any repost (kind 6/16)
    // that references this id, extract the `a`-tag coordinate, and fetch the
    // current version through the addressable pipeline. Without this, SNV links
    // from old bookmarks / old repost references show "Note not found".
    if (!event) {
      this.systemLogger.info('SNV', `Looking up newer version of this post…`);
      event = await resolveAddressableFromReferences(noteId);
    }

    if (!event) {
      this.systemLogger.warn('SNV', `Note not found (${noteId.slice(0, 8)})`);
      return null;
    }

    let authorPubkey = event.pubkey;
    if (event.kind === 6 || event.kind === 16) {
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
    // Repost unwrap: use the universal helper so the inner event is resolved
    // through (1) embedded JSON, (2) e-tag fetch via QuoteOrchestrator with
    // relay hint + outbound fallback, (3) for addressable inner kinds (30311
    // live stream, 30023 article, …) the a-tag fallback. The previous hex-id
    // fetch via fetchNote failed for replaceable events whose original id is
    // no longer carried by relays after the author published a newer version
    // under the same coordinate.
    if (event.kind === 6 || event.kind === 16) {
      const original = await getRepostsOriginalEvent(event);
      if (original === event) {
        // No source found at all — surface as "Original note not found"
        // rather than rendering the empty repost shell.
        this.showError('Original note not found');
        return;
      }
      event = original;
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

    // For addressable events (NIP-33 kinds 30000–39999) the ISL, replies,
    // reactions and zap pipelines key off the coordinate (`kind:pubkey:d-tag`)
    // rather than the hex event id — see extractOriginalNoteId. ThreadManager
    // and LiveUpdatesManager therefore need the same identifier or they look
    // up the wrong slot.
    const effectiveNoteId = extractOriginalNoteId(event) ?? eventId;

    this.currentNoteId = effectiveNoteId;
    this.currentEvent = event;

    this.initializeManagers(effectiveNoteId, eventPubkey, repliesContainer);
    this.loadZapsList(effectiveNoteId, eventPubkey, noteElement);

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
      rootKind: this.currentEvent?.kind,
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
      // ensure() so the zaps/likes lists load on public, logged-out note views.
      const reactionsApi = await ModuleLoader.getInstance().ensure<ReactionsModuleApi>('reactions');
      const stats = await reactionsApi?.getDetailedStats(noteId);
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
