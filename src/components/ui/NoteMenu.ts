/**
 * NoteMenu Component
 * Reusable dropdown menu for note actions (Copy ID, Share, Mute, etc.)
 * Single responsibility: Provide context menu for any note in any view
 * Used in: Timeline View, Single Note View, Profile View
 */

import { type Event as NostrEvent } from '../../services/NostrToolsAdapter';
import { FeedOrchestrator } from '../../services/orchestration/FeedOrchestrator';
import { NotificationsOrchestrator } from '../../services/orchestration/NotificationsOrchestrator';
import { RawEventModal } from '../raw-event/RawEventModal';
import { ReportModal } from '../report/ReportModal';
import { DeleteNoteModal } from '../delete/DeleteNoteModal';
import { AuthService } from '../../services/AuthService';
import { BookmarkOrchestrator } from '../../services/orchestration/BookmarkOrchestrator';
import { TribeOrchestrator } from '../../services/orchestration/TribeOrchestrator';
import { TribeFolderService } from '../../services/TribeFolderService';
import { MuteOrchestrator } from '../../services/orchestration/MuteOrchestrator';
import { ArticleNotificationService } from '../../services/ArticleNotificationService';
import { AuthGuard } from '../../services/AuthGuard';
import { ToastService } from '../../services/ToastService';
import { EventBus } from '../../services/EventBus';
import { ClipboardActionsService } from '../../services/ClipboardActionsService';
import { ModalService } from '../../services/ModalService';

export interface NoteMenuOptions {
  eventId: string;
  authorPubkey: string;
  rawEvent?: NostrEvent;
}

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
    trigger.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
        <circle cx="8" cy="2" r="1.5" />
        <circle cx="8" cy="8" r="1.5" />
        <circle cx="8" cy="14" r="1.5" />
      </svg>
    `;

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
    const isOwnNote = currentUser && currentUser.pubkey === this.options.authorPubkey;

    // Check if private bookmarks are enabled
    const bookmarkOrch = BookmarkOrchestrator.getInstance();
    const privateBookmarksEnabled = bookmarkOrch.isPrivateBookmarksEnabled();

    // Check current bookmark status
    let isPublicBookmarked = false;
    let isPrivateBookmarked = false;
    if (currentUser) {
      const status = await bookmarkOrch.isBookmarked(this.options.eventId, currentUser.pubkey);
      isPublicBookmarked = status.public;
      isPrivateBookmarked = status.private;
    }

    // Check if thread is muted
    const muteOrch = MuteOrchestrator.getInstance();
    const isThreadMuted = await muteOrch.isEventMuted(this.options.eventId);
    const privateMutesEnabled = muteOrch.isPrivateMutesEnabled();

    // Check if subscribed to article notifications for this user
    const articleNotifService = ArticleNotificationService.getInstance();
    const isSubscribedToArticles = articleNotifService.isSubscribed(this.options.authorPubkey);

    // Bookmark icon SVG
    const bookmarkIcon = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M3 2h10a1 1 0 0 1 1 1v11l-6-3-6 3V3a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;

    // Mute thread icon SVG (conversation bubble with slash)
    const muteThreadIcon = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M2 2l12 12M3 12l-1 3 3-1 7-7M12 4a2 2 0 0 0-3-3L4 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;

    // Tribe icon SVG (users group)
    const tribeIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="9" cy="7" r="4" stroke="currentColor" stroke-width="1.5"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;

    menu.innerHTML = `
      <button class="note-menu-item" data-action="copy-event-id">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="2" y="2" width="9" height="9" rx="1" stroke="currentColor" stroke-width="1.5"/>
          <path d="M5 5v-1a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-1" stroke="currentColor" stroke-width="1.5"/>
        </svg>
        Copy event ID
      </button>

      <button class="note-menu-item" data-action="copy-user-id">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="2" y="2" width="9" height="9" rx="1" stroke="currentColor" stroke-width="1.5"/>
          <path d="M5 5v-1a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-1" stroke="currentColor" stroke-width="1.5"/>
        </svg>
        Copy user ID
      </button>

      <button class="note-menu-item" data-action="copy-share-link">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M6.5 9.5l3-3M9 6.5l2.5-2.5a2.121 2.121 0 1 1 3 3L12 9.5m-2.5 0L7 12a2.121 2.121 0 1 1-3-3l2.5-2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        Copy share link
      </button>

      ${privateBookmarksEnabled ? `
        <button class="note-menu-item" data-action="bookmark-public">
          ${bookmarkIcon}
          ${isPublicBookmarked ? 'Remove Public Bookmark' : 'Public Bookmark'}
        </button>
        <button class="note-menu-item" data-action="bookmark-private">
          ${bookmarkIcon}
          ${isPrivateBookmarked ? 'Remove Private Bookmark' : 'Private Bookmark'}
        </button>
      ` : `
        <button class="note-menu-item" data-action="bookmark-public">
          ${bookmarkIcon}
          ${isPublicBookmarked ? 'Remove Bookmark' : 'Bookmark'}
        </button>
      `}

      ${!isOwnNote ? `
        <button class="note-menu-item" data-action="add-author-to-tribe">
          ${tribeIcon}
          Add author to Tribe
        </button>
      ` : ''}

      <button class="note-menu-item" data-action="view-raw-event">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M5 6l-3 2 3 2M11 6l3 2-3 2M10 2l-4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        View raw event
      </button>

      <div class="note-menu-divider"></div>

      ${isOwnNote ? `
        <button class="note-menu-item note-menu-item--danger" data-action="delete-note">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M3 4h10M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1M6 7v4M10 7v4M4 4l.5 8.5a1 1 0 0 0 1 .95h5a1 1 0 0 0 1-.95L12 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Delete note
        </button>
        <div class="note-menu-divider"></div>
      ` : ''}

      <button class="note-menu-item note-menu-item--danger" data-action="report">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M8 2v6M8 11v1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          <circle cx="8" cy="13.5" r="0.5" fill="currentColor"/>
        </svg>
        Report
      </button>

      ${privateMutesEnabled ? `
        <button class="note-menu-item note-menu-item--danger" data-action="mute-user-privately">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M2 2l12 12M6.5 6.5A3 3 0 0 0 10 10m-2-2v4a2 2 0 1 1-4 0V6a2 2 0 0 1 2-2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Mute user privately
        </button>
        <button class="note-menu-item note-menu-item--danger" data-action="mute-user-publicly">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M2 2l12 12M6.5 6.5A3 3 0 0 0 10 10m-2-2v4a2 2 0 1 1-4 0V6a2 2 0 0 1 2-2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Mute user publicly
        </button>
      ` : `
        <button class="note-menu-item note-menu-item--danger" data-action="mute-user-publicly">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M2 2l12 12M6.5 6.5A3 3 0 0 0 10 10m-2-2v4a2 2 0 1 1-4 0V6a2 2 0 0 1 2-2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Mute user
        </button>
      `}

      <div class="note-menu-divider"></div>

      <button class="note-menu-item note-menu-item--warning" data-action="toggle-mute-thread">
        ${muteThreadIcon}
        ${isThreadMuted ? 'Unmute thread' : 'Mute thread'}
      </button>

      <div class="note-menu-divider"></div>

      <button class="note-menu-item" data-action="toggle-article-notifications">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M8 1.5a4.5 4.5 0 0 0-4.5 4.5v3l-1 2h11l-1-2V6A4.5 4.5 0 0 0 8 1.5zM6.5 12a1.5 1.5 0 0 0 3 0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
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
    const feedOrchestrator = FeedOrchestrator.getInstance();
    const relays = feedOrchestrator.getEventRelays(this.options.eventId);

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
        this.muteUserPrivately();
        break;
      case 'mute-user-publicly':
        this.muteUserPublicly();
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
    await clipboardService.copyEventId(this.options.eventId);
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
    await clipboardService.copyShareLink(this.options.eventId);
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
   * Mute user privately (NIP-51 encrypted mute list)
   */
  private async muteUserPrivately(): Promise<void> {
    // AuthGuard check
    if (!AuthGuard.requireAuth('mute user')) {
      return;
    }

    const muteOrch = MuteOrchestrator.getInstance();

    try {
      await muteOrch.muteUser(this.options.authorPubkey, true);
      ToastService.show('User muted privately', 'success');

      // Refresh muted users in orchestrators
      const feedOrch = FeedOrchestrator.getInstance();
      const notifOrch = NotificationsOrchestrator.getInstance();
      await Promise.all([
        feedOrch.refreshMutedUsers(),
        notifOrch.refreshMutedUsers()
      ]);

      // Notify feed to refresh
      const eventBus = EventBus.getInstance();
      eventBus.emit('mute:updated', {});
    } catch (error) {
      console.error('Failed to mute user privately:', error);
      ToastService.show('Failed to mute user', 'error');
    }
  }

  /**
   * Mute user publicly (NIP-51 public mute list)
   */
  private async muteUserPublicly(): Promise<void> {
    // AuthGuard check
    if (!AuthGuard.requireAuth('mute user')) {
      return;
    }

    const muteOrch = MuteOrchestrator.getInstance();

    try {
      await muteOrch.muteUser(this.options.authorPubkey, false);
      ToastService.show('User muted publicly', 'success');

      // Refresh muted users in orchestrators
      const feedOrch = FeedOrchestrator.getInstance();
      const notifOrch = NotificationsOrchestrator.getInstance();
      await Promise.all([
        feedOrch.refreshMutedUsers(),
        notifOrch.refreshMutedUsers()
      ]);

      // Notify feed to refresh
      const eventBus = EventBus.getInstance();
      eventBus.emit('mute:updated', {});
    } catch (error) {
      console.error('Failed to mute user publicly:', error);
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

    const articleNotifService = ArticleNotificationService.getInstance();
    const isNowSubscribed = articleNotifService.toggle(this.options.authorPubkey);

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

    const tribeFolderService = TribeFolderService.getInstance();
    const tribes = tribeFolderService.getFolders();

    if (tribes.length === 0) {
      ToastService.show('No tribes found. Create a tribe first.', 'info');
      return;
    }

    // Build tribe selection list HTML
    const tribeListHtml = tribes.map(tribe =>
      `<button class="btn btn--medium" data-tribe-id="${tribe.id}" style="margin: 0.5rem 0; width: 100%;">${tribe.name}</button>`
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
    const tribeOrch = TribeOrchestrator.getInstance();
    const tribeFolderService = TribeFolderService.getInstance();

    try {
      // Check if tribe uses private members
      const isPrivate = tribeOrch.isPrivateTribesEnabled();

      // Add member to tribe
      await tribeOrch.addMember(this.options.authorPubkey, isPrivate, tribeFolderId);

      // Get tribe name for toast message
      const tribes = tribeFolderService.getFolders();
      const tribe = tribes.find(t => t.id === tribeFolderId);
      const tribeName = tribe ? tribe.name : 'Tribe';

      ToastService.show(`Author added to ${tribeName}`, 'success');

      // Notify tribe list to refresh
      const eventBus = EventBus.getInstance();
      eventBus.emit('tribe:updated', {});
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
