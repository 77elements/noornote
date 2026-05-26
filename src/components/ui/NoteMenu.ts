/**
 * NoteMenu Component
 * Reusable dropdown menu for note actions (Copy ID, Share, Mute, etc.)
 * Single responsibility: Provide context menu for any note in any view
 * Used in: Timeline View, Single Note View, Profile View
 */

import { type Event as NostrEvent } from '../../services/NostrToolsAdapter';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { TimelineModuleApi } from '../../modules/timeline/contracts';
import type { NotificationsModuleApi } from '../../modules/notifications/contracts';
import { RawEventModal } from '../raw-event/RawEventModal';
import { ReportModal } from '../report/ReportModal';
import { DeleteNoteModal } from '../delete/DeleteNoteModal';
import { AuthService } from '../../services/AuthService';
import { MuteOrchestrator } from '../../lists/mutes';
import type { ArticlesModuleApi } from '../../modules/articles/contracts';
import { AuthGuard } from '../../services/AuthGuard';
import { ToastService } from '../../services/ToastService';
import { EventBus } from '../../services/EventBus';
import { ClipboardActionsService } from '../../services/ClipboardActionsService';
import { ModalService } from '../../services/ModalService';
import { isBookmarksEnabled } from '../../addons/bookmarks/index';
import { isTribesEnabled } from '../../addons/tribes/index';

export interface NoteMenuOptions {
  eventId: string;
  authorPubkey: string;
  rawEvent?: NostrEvent;
}

// SVG sprite icon helper — references symbols from index.html sprite sheet
const icon = (id: string, size = 16) => `<svg width="${size}" height="${size}"><use href="#icon-${id}"/></svg>`;

const ICONS = {
  copy: icon('copy'),
  bookmark: icon('bookmark'),
  tribe: icon('tribe'),
  code: icon('code'),
  trash: icon('trash'),
  report: icon('report'),
  mute: icon('mute'),
  muteThread: icon('mute-thread'),
  notification: icon('bell'),
  link: icon('link'),
} as const;

export class NoteMenu {
  private triggerElement: HTMLElement;
  private menuElement: HTMLElement;
  private options: NoteMenuOptions;
  private isOpen: boolean = false;
  private outsideClickHandler: () => void;

  constructor(options: NoteMenuOptions) {
    this.options = options;
    this.triggerElement = this.createTrigger();
    this.menuElement = document.createElement('div'); // Placeholder, will be built on open
    this.outsideClickHandler = () => this.closeMenu();
    this.setupEventListeners();
  }

  /**
   * Create the 3-dot menu trigger button
   */
  private createTrigger(): HTMLElement {
    const trigger = document.createElement('button');
    trigger.className = 'note-menu-trigger';
    trigger.setAttribute('aria-label', 'Note options');
    trigger.innerHTML = `<svg width="16" height="16"><use href="#icon-menu-dots"/></svg>`;

    return trigger;
  }

  /**
   * Create the dropdown menu
   */
  private async createMenu(): Promise<HTMLElement> {
    const menu = document.createElement('div');
    menu.className = 'note-menu-dropdown';
    menu.style.display = 'none';

    // Check if this is the current user's note
    const authService = AuthService.getInstance();
    const currentUser = authService.getCurrentUser();
    const isOwnNote = authService.isCurrentUser(this.options.authorPubkey);

    // Check bookmark status (only if addon enabled)
    let bookmarkButtons = '';
    if (isBookmarksEnabled()) {
      const { BookmarkOrchestrator } = await import('../../lists/bookmarks');
      const bookmarkOrch = BookmarkOrchestrator.getInstance();
      const privateBookmarksEnabled = bookmarkOrch.isPrivateBookmarksEnabled();

      let isPublicBookmarked = false;
      let isPrivateBookmarked = false;
      if (currentUser) {
        const status = await bookmarkOrch.isBookmarked(this.options.eventId, currentUser.pubkey);
        isPublicBookmarked = status.public;
        isPrivateBookmarked = status.private;
      }

      bookmarkButtons = privateBookmarksEnabled ? `
        <button class="note-menu-item" data-action="bookmark-public">
          ${ICONS.bookmark}
          ${isPublicBookmarked ? 'Remove Public Bookmark' : 'Public Bookmark'}
        </button>
        <button class="note-menu-item" data-action="bookmark-private">
          ${ICONS.bookmark}
          ${isPrivateBookmarked ? 'Remove Private Bookmark' : 'Private Bookmark'}
        </button>
      ` : `
        <button class="note-menu-item" data-action="bookmark-public">
          ${ICONS.bookmark}
          ${isPublicBookmarked ? 'Remove Bookmark' : 'Bookmark'}
        </button>
      `;
    }

    // Check if thread is muted
    const muteOrch = MuteOrchestrator.getInstance();
    const isThreadMuted = await muteOrch.isEventMuted(this.options.eventId);
    const privateMutesEnabled = muteOrch.isPrivateMutesEnabled();

    // Check if subscribed to article notifications for this user
    const articlesApi = ModuleLoader.getInstance().getApi<ArticlesModuleApi>('articles');
    const isSubscribedToArticles = articlesApi?.isSubscribedToArticleNotifications(this.options.authorPubkey) ?? false;

    // Build mute user buttons based on private mutes setting
    const muteUserButtons = privateMutesEnabled ? `
      <button class="note-menu-item note-menu-item--danger" data-action="mute-user-privately">
        ${ICONS.mute}
        Mute user privately
      </button>
      <button class="note-menu-item note-menu-item--danger" data-action="mute-user-publicly">
        ${ICONS.mute}
        Mute user publicly
      </button>
    ` : `
      <button class="note-menu-item note-menu-item--danger" data-action="mute-user-publicly">
        ${ICONS.mute}
        Mute user
      </button>
    `;

    menu.innerHTML = `
      <button class="note-menu-item" data-action="copy-event-id">
        ${ICONS.copy}
        Copy event ID
      </button>

      <button class="note-menu-item" data-action="copy-user-id">
        ${ICONS.copy}
        Copy user ID
      </button>

      <button class="note-menu-item" data-action="copy-share-link">
        ${ICONS.link}
        Copy share link
      </button>

      ${bookmarkButtons}

      ${!isOwnNote && isTribesEnabled() ? `
        <button class="note-menu-item" data-action="add-author-to-tribe">
          ${ICONS.tribe}
          Add author to Tribe
        </button>
      ` : ''}

      <button class="note-menu-item" data-action="view-raw-event">
        ${ICONS.code}
        View raw event
      </button>

      <div class="note-menu-divider"></div>

      ${isOwnNote ? `
        <button class="note-menu-item note-menu-item--danger" data-action="delete-note">
          ${ICONS.trash}
          Delete note
        </button>
        <div class="note-menu-divider"></div>
      ` : ''}

      <button class="note-menu-item note-menu-item--danger" data-action="report">
        ${ICONS.report}
        Report
      </button>

      ${muteUserButtons}

      <div class="note-menu-divider"></div>

      <button class="note-menu-item note-menu-item--warning" data-action="toggle-mute-thread">
        ${ICONS.muteThread}
        ${isThreadMuted ? 'Unmute thread' : 'Mute thread'}
      </button>

      <div class="note-menu-divider"></div>

      <button class="note-menu-item" data-action="toggle-article-notifications">
        ${ICONS.notification}
        ${isSubscribedToArticles ? 'Stop article notifications' : 'Notify on new articles'}
      </button>
    `;

    // Add relay section
    this.addRelaySection(menu);

    // Append menu to body for proper positioning
    document.body.appendChild(menu);

    return menu;
  }

  /**
   * Add relay section to menu
   */
  private addRelaySection(menu: HTMLElement): void {
    const timelineApi = ModuleLoader.getInstance().getApi<TimelineModuleApi>('timeline');
    const relays = timelineApi?.getEventRelays(this.options.eventId) ?? [];

    // Only show section if we have relay data
    if (!relays || relays.length === 0) {
      return;
    }

    // Create divider
    const divider = document.createElement('div');
    divider.className = 'note-menu-divider';
    menu.appendChild(divider);

    // Create header
    const header = document.createElement('div');
    header.className = 'note-menu-section-header';
    header.textContent = 'Seen on';
    menu.appendChild(header);

    // Create relay list
    relays.forEach((relay) => {
      const relayItem = document.createElement('div');
      relayItem.className = 'note-menu-relay-item';
      relayItem.textContent = this.formatRelayUrl(relay);
      menu.appendChild(relayItem);
    });
  }

  /**
   * Format relay URL for display
   */
  private formatRelayUrl(url: string): string {
    // Remove wss:// or ws:// prefix for cleaner display
    return url.replace(/^wss?:\/\//, '');
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Toggle menu on trigger click
    this.triggerElement.addEventListener('click', async (e) => {
      e.stopPropagation();
      await this.toggleMenu();
    });

    // Menu item clicks are handled in openMenu() after menu rebuild
  }

  /**
   * Toggle menu visibility
   */
  private async toggleMenu(): Promise<void> {
    if (this.isOpen) {
      this.closeMenu();
    } else {
      await this.openMenu();
    }
  }

  /**
   * Open menu
   */
  private async openMenu(): Promise<void> {
    // Close any other open menus
    document.querySelectorAll('.note-menu-dropdown').forEach((menu) => {
      if (menu !== this.menuElement) {
        (menu as HTMLElement).style.display = 'none';
      }
    });

    // Rebuild menu to get fresh bookmark status
    const oldMenu = this.menuElement;
    this.menuElement = await this.createMenu();

    // Replace old menu in DOM if it exists
    if (oldMenu.parentNode) {
      oldMenu.parentNode.replaceChild(this.menuElement, oldMenu);
    } else {
      document.body.appendChild(this.menuElement);
    }

    // Re-setup menu click listener for new menu element
    this.menuElement.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = e.target as HTMLElement;
      const menuItem = target.closest('.note-menu-item') as HTMLElement;

      if (menuItem) {
        const action = menuItem.dataset.action;
        if (action) {
          this.handleAction(action);
          this.closeMenu();
        }
      }
    });

    this.menuElement.style.display = 'block';
    this.isOpen = true;

    // Position menu relative to trigger
    this.positionMenu();

    // Add outside click listener
    setTimeout(() => {
      document.addEventListener('click', this.outsideClickHandler);
    }, 0);
  }

  /**
   * Close menu
   */
  private closeMenu(): void {
    this.menuElement.style.display = 'none';
    this.isOpen = false;

    // Remove outside click listener
    document.removeEventListener('click', this.outsideClickHandler);
  }

  /**
   * Position menu near trigger
   */
  private positionMenu(): void {
    const triggerRect = this.triggerElement.getBoundingClientRect();
    const menuRect = this.menuElement.getBoundingClientRect();
    const viewportHeight = window.innerHeight;

    // Default: position below and to the right of trigger
    let top = triggerRect.bottom + 4;
    let left = triggerRect.right - menuRect.width;

    // If menu would overflow viewport bottom, position above trigger
    if (top + menuRect.height > viewportHeight) {
      top = triggerRect.top - menuRect.height - 4;
    }

    // If menu would overflow viewport left, align to left of trigger
    if (left < 0) {
      left = triggerRect.left;
    }

    this.menuElement.style.position = 'fixed';
    this.menuElement.style.top = `${top}px`;
    this.menuElement.style.left = `${left}px`;
    this.menuElement.style.zIndex = '1000';
  }

  /**
   * Handle menu actions
   */
  private handleAction(action: string): void {
    switch (action) {
      case 'copy-event-id':
        this.copyEventId();
        break;
      case 'copy-user-id':
        this.copyUserId();
        break;
      case 'copy-share-link':
        this.copyShareLink();
        break;
      case 'bookmark-public':
        this.toggleBookmark(false);
        break;
      case 'bookmark-private':
        this.toggleBookmark(true);
        break;
      case 'add-author-to-tribe':
        this.addAuthorToTribe();
        break;
      case 'view-raw-event':
        this.viewRawEvent();
        break;
      case 'delete-note':
        this.deleteNote();
        break;
      case 'report':
        this.reportNote();
        break;
      case 'mute-user-privately':
        this.muteUser(true);
        break;
      case 'mute-user-publicly':
        this.muteUser(false);
        break;
      case 'toggle-mute-thread':
        this.toggleMuteThread();
        break;
      case 'toggle-article-notifications':
        this.toggleArticleNotifications();
        break;
      default:
        console.warn(`Unknown action: ${action}`);
    }
  }

  /**
   * Copy event ID to clipboard (nevent format)
   */
  private async copyEventId(): Promise<void> {
    const clipboardService = ClipboardActionsService.getInstance();
    await clipboardService.copyEventId(this.options.eventId, this.options.authorPubkey);
  }

  /**
   * Copy user ID (npub) to clipboard
   */
  private async copyUserId(): Promise<void> {
    const clipboardService = ClipboardActionsService.getInstance();
    await clipboardService.copyUserPubkey(this.options.authorPubkey);
  }

  /**
   * Copy share link (nevent) to clipboard
   */
  private async copyShareLink(): Promise<void> {
    const clipboardService = ClipboardActionsService.getInstance();
    await clipboardService.copyShareLink(this.options.eventId, this.options.authorPubkey);
  }

  /**
   * View raw event JSON
   */
  private viewRawEvent(): void {
    if (!this.options.rawEvent) {
      console.warn('Raw event not available');
      ToastService.show('Raw event data not available', 'error');
      return;
    }

    const rawEventModal = RawEventModal.getInstance();
    rawEventModal.show(this.options.rawEvent);
  }

  /**
   * Delete note (NIP-09)
   */
  private deleteNote(): void {
    const deleteModal = DeleteNoteModal.getInstance();
    deleteModal.show({
      eventId: this.options.eventId
    });
  }

  /**
   * Report note (NIP-56)
   */
  private reportNote(): void {
    const reportModal = ReportModal.getInstance();
    reportModal.show({
      reportedPubkey: this.options.authorPubkey,
      reportedEventId: this.options.eventId
    });
  }

  /**
   * Mute user (NIP-51 mute list)
   * @param isPrivate - true for encrypted mute list, false for public
   */
  private async muteUser(isPrivate: boolean): Promise<void> {
    if (!AuthGuard.requireAuth('mute user')) {
      return;
    }

    const muteOrch = MuteOrchestrator.getInstance();

    try {
      await muteOrch.muteUser(this.options.authorPubkey, isPrivate);
      ToastService.show(isPrivate ? 'User muted privately' : 'User muted publicly', 'success');

      // Refresh muted users in orchestrators
      const loader = ModuleLoader.getInstance();
      const timelineApi = loader.getApi<TimelineModuleApi>('timeline');
      const notifApi = loader.getApi<NotificationsModuleApi>('notifications');
      await Promise.all([
        timelineApi?.refreshMutedUsers() ?? Promise.resolve(),
        notifApi?.refreshMutedUsers() ?? Promise.resolve()
      ]);

      EventBus.getInstance().emit('mute:updated', {});
    } catch (error) {
      console.error(`Failed to mute user ${isPrivate ? 'privately' : 'publicly'}:`, error);
      ToastService.show('Failed to mute user', 'error');
    }
  }

  /**
   * Toggle thread mute state (mute/unmute)
   * Uses public mute list (NIP-51 Kind 10000 with "e" tag)
   */
  private async toggleMuteThread(): Promise<void> {
    if (!AuthGuard.requireAuth('mute thread')) {
      return;
    }

    const muteOrch = MuteOrchestrator.getInstance();
    const eventBus = EventBus.getInstance();

    try {
      const isCurrentlyMuted = await muteOrch.isEventMuted(this.options.eventId);

      if (isCurrentlyMuted) {
        await muteOrch.unmuteThread(this.options.eventId);
        ToastService.show('Thread unmuted', 'success');
      } else {
        await muteOrch.muteThread(this.options.eventId, false); // false = public
        ToastService.show('Thread muted', 'success');
      }

      // Notify UI to refresh
      eventBus.emit('mute:thread:updated', { eventId: this.options.eventId });
      eventBus.emit('mute:updated', {});
    } catch (error) {
      console.error('Failed to toggle thread mute:', error);
      ToastService.show('Failed to update thread mute', 'error');
    }
  }

  /**
   * Toggle article notification subscription for the note's author
   */
  private toggleArticleNotifications(): void {
    if (!AuthGuard.requireAuth('subscribe to article notifications')) {
      return;
    }

    const articlesApi = ModuleLoader.getInstance().getApi<ArticlesModuleApi>('articles');
    const isNowSubscribed = articlesApi?.toggleArticleNotifications(this.options.authorPubkey) ?? false;

    if (isNowSubscribed) {
      ToastService.show('You will be notified about new articles', 'success');
    } else {
      ToastService.show('Article notifications disabled', 'success');
    }
  }

  /**
   * Toggle bookmark (add/remove)
   */
  private async toggleBookmark(isPrivate: boolean): Promise<void> {
    // AuthGuard check
    if (!AuthGuard.requireAuth('bookmark note')) {
      return;
    }

    const authService = AuthService.getInstance();
    const currentUser = authService.getCurrentUser();
    if (!currentUser) return;

    const { BookmarkOrchestrator } = await import('../../lists/bookmarks');
    const bookmarkOrch = BookmarkOrchestrator.getInstance();

    try {
      // For Reposts (Kind 6), bookmark the reposted note, not the repost itself
      let eventIdToBookmark = this.options.eventId;
      if (this.options.rawEvent && this.options.rawEvent.kind === 6) {
        // Extract reposted event ID from 'e' tag
        const eTag = this.options.rawEvent.tags.find(tag => tag[0] === 'e');
        if (eTag && eTag[1]) {
          eventIdToBookmark = eTag[1];
        }
      }

      // Check current bookmark status
      const status = await bookmarkOrch.isBookmarked(eventIdToBookmark, currentUser.pubkey);
      const isCurrentlyBookmarked = isPrivate ? status.private : status.public;

      if (isCurrentlyBookmarked) {
        // Remove bookmark
        await bookmarkOrch.removeBookmark(eventIdToBookmark, isPrivate);
        ToastService.show(
          isPrivate ? 'Removed from private bookmarks' : 'Removed from bookmarks',
          'success'
        );
      } else {
        // Add bookmark
        await bookmarkOrch.addBookmark(eventIdToBookmark, isPrivate);
        ToastService.show(
          isPrivate ? 'Added to private bookmarks' : 'Added to bookmarks',
          'success'
        );
      }

      // Notify bookmarks list to refresh
      const eventBus = EventBus.getInstance();
      eventBus.emit('bookmark:updated', {});
    } catch (error) {
      console.error('Failed to toggle bookmark:', error);
      ToastService.show('Failed to update bookmark', 'error');
    }
  }

  /**
   * Add author to tribe
   */
  private async addAuthorToTribe(): Promise<void> {
    // AuthGuard check
    if (!AuthGuard.requireAuth('add to tribe')) {
      return;
    }

    const tribes = await import('../../lists/tribes');
    const tribeFolders = tribes.getFolders();

    if (tribeFolders.length === 0) {
      ToastService.show('No tribes found. Create a tribe first.', 'info');
      return;
    }

    // Build tribe selection list HTML
    const tribeListHtml = tribeFolders.map(folder =>
      `<button class="btn btn--medium" data-tribe-id="${folder.id}" style="margin: 0.5rem 0; width: 100%;">${folder.name}</button>`
    ).join('');

    const modalService = ModalService.getInstance();
    modalService.show({
      title: 'Add author to Tribe',
      content: `
        <div style="padding: 1rem 0;">
          <p style="margin-bottom: 1rem;">Select a tribe to add this author to:</p>
          <div class="tribe-selection-list">
            ${tribeListHtml}
          </div>
        </div>
      `,
      width: '400px',
      showCloseButton: true,
      closeOnOverlay: true,
      closeOnEsc: true
    });

    // Wait for modal to be in DOM
    setTimeout(() => {
      const tribeButtons = document.querySelectorAll('[data-tribe-id]');
      tribeButtons.forEach(button => {
        button.addEventListener('click', async () => {
          const tribeId = (button as HTMLElement).dataset.tribeId;
          if (tribeId) {
            await this.performAddAuthorToTribe(tribeId);
            modalService.hide();
          }
        });
      });
    }, 0);
  }

  /**
   * Perform add author to tribe action
   */
  private async performAddAuthorToTribe(tribeFolderId: string): Promise<void> {
    try {
      const tribes = await import('../../lists/tribes');
      // Get tribe folder to get the name (for NIP-51 category)
      const folder = tribes.getFolder(tribeFolderId);
      const tribeName = folder?.name || '';

      // Add member to tribe as public (private tribes not supported via NoteMenu)
      // Note: addMember already emits 'tribe:updated', no need to emit again
      await tribes.addMember(this.options.authorPubkey, false, tribeName, tribeFolderId);

      ToastService.show(`Author added to ${tribeName}`, 'success');
    } catch (error) {
      console.error('Failed to add author to tribe:', error);
      ToastService.show('Failed to add author to tribe', 'error');
    }
  }

  /**
   * Get trigger element (to mount in parent)
   */
  public getTrigger(): HTMLElement {
    return this.triggerElement;
  }

  /**
   * Destroy component and cleanup
   */
  public destroy(): void {
    this.closeMenu();
    document.removeEventListener('click', this.outsideClickHandler);
    this.triggerElement.remove();
    this.menuElement.remove();
  }
}
