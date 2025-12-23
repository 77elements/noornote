/**
 * MessagesView Component
 * NIP-17 Private Direct Messages - Conversations List
 *
 * @view MessagesView
 * @purpose Display list of DM conversations with Known/Unknown tabs
 * @used-by App.ts via Router
 */

import { View } from './View';
import { DMService } from '../../services/dm/DMService';
import type { DMConversation } from '../../services/dm/DMStore';
import { UserProfileService } from '../../services/UserProfileService';
import { EventBus } from '../../services/EventBus';
import { Router } from '../../services/Router';
import { SystemLogger } from '../system/SystemLogger';
import { setupUserMentionHandlers } from '../../helpers/UserMentionHelper';
import { InfiniteScroll } from '../ui/InfiniteScroll';
import { ToastService } from '../../services/ToastService';
import { setupTabClickHandlers, switchTabWithContent } from '../../helpers/TabsHelper';
import { escapeHtml } from '../../helpers/escapeHtml';
import { ProgressBarHelper } from '../../helpers/ProgressBarHelper';
import { formatTimestamp } from '../../helpers/formatTimestamp';
import { DMComposeModal } from '../modals/DMComposeModal';

const BATCH_SIZE = 15;

type TabFilter = 'known' | 'unknown';

export class MessagesView extends View {
  private container: HTMLElement;
  private dmService: DMService;
  private userProfileService: UserProfileService;
  private eventBus: EventBus;
  private router: Router;
  private systemLogger: SystemLogger;
  private conversations: DMConversation[] = [];
  private isLoading: boolean = false;
  private currentOffset: number = 0;
  private hasMoreConversations: boolean = true;
  private infiniteScroll: InfiniteScroll;
  private menuOpen: boolean = false;
  private outsideClickHandler: () => void;
  private activeTab: TabFilter = 'known';
  private subscriptionIds: string[] = [];
  private progressBar: ProgressBarHelper | null = null;
  private isFetchingDMs: boolean = false;

  constructor() {
    super();

    this.container = document.createElement('div');
    this.container.className = 'messages-view';
    this.dmService = DMService.getInstance();
    this.userProfileService = UserProfileService.getInstance();
    this.eventBus = EventBus.getInstance();
    this.router = Router.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.infiniteScroll = new InfiniteScroll(() => this.handleLoadMore(), {
      loadingMessage: 'Loading more conversations...'
    });
    this.outsideClickHandler = () => this.closeMenu();

    this.render();
    this.setupEventListeners();
    this.setupInfiniteScroll();

    // IMPORTANT: Setup event listeners BEFORE loadInitialData()
    // because dmService.start() may emit events immediately if already running
    // Listen for fetch progress updates (for progress bar)
    this.subscriptionIds.push(
      this.eventBus.on('dm:fetch-progress', (data: { current: number; total: number }) => {
        this.handleFetchProgress(data);
      })
    );

    // Listen for fetch completion - then load conversations
    this.subscriptionIds.push(
      this.eventBus.on('dm:fetch-complete', () => {
        this.handleFetchComplete();
      })
    );

    // Call loadInitialData AFTER event listeners are setup
    this.loadInitialData();

    // Listen for badge updates (mark all read/unread) - only update badges, not full refresh
    this.subscriptionIds.push(
      this.eventBus.on('dm:badge-update', () => {
        // Only refresh if we're not currently fetching
        if (!this.isFetchingDMs) {
          this.updateBadgeCounts();
          this.refreshConversationsQuiet();
        }
      })
    );

    // Listen for new messages during live subscription (after initial fetch)
    this.subscriptionIds.push(
      this.eventBus.on('dm:new-message', () => {
        // Only refresh if we're not currently fetching
        if (!this.isFetchingDMs) {
          this.refreshConversationsQuiet();
        }
      })
    );
  }

  /**
   * Render the messages view structure
   */
  private render(): void {
    this.container.innerHTML = `
      <div class="messages-view__header progress-bar-container">
        <h1>Messages</h1>
        <div class="messages-view__actions">
          <button class="btn btn--medium messages-view__compose-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
              <path d="M12 5v14M5 12h14"/>
            </svg>
            New Message
          </button>
          <button class="dropdown-menu-trigger messages-view__menu-trigger" aria-label="Message options">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <circle cx="8" cy="2" r="1.5" />
              <circle cx="8" cy="8" r="1.5" />
              <circle cx="8" cy="14" r="1.5" />
            </svg>
          </button>
          <div class="dropdown-menu messages-view__menu" style="display: none;">
            <button class="dropdown-menu-item" data-action="mark-all-read">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M2 8l4 4 8-8"/>
              </svg>
              Mark all read
            </button>
            <button class="dropdown-menu-item" data-action="mark-all-unread">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                <circle cx="8" cy="8" r="6"/>
              </svg>
              Mark all unread
            </button>
          </div>
        </div>
      </div>
      <div class="messages-view__tabs">
        <div class="tabs">
          <button class="tab tab--active" data-tab="known">
            Known
            <span class="badge" data-badge="known" style="display: none;"></span>
          </button>
          <button class="tab" data-tab="unknown">
            Unknown
            <span class="badge" data-badge="unknown" style="display: none;"></span>
          </button>
        </div>
      </div>
      <div class="messages-view__content">
        <div class="tab-content tab-content--active" data-tab-content="known">
          <div class="messages-view__list" data-list="known">
            <div class="messages-view__loading">Loading messages...</div>
          </div>
        </div>
        <div class="tab-content" data-tab-content="unknown">
          <div class="messages-view__list" data-list="unknown">
            <div class="messages-view__loading">Loading messages...</div>
          </div>
        </div>
      </div>
    `;

    // Initialize progress bar on header
    const header = this.container.querySelector('.messages-view__header') as HTMLElement;
    if (header) {
      this.progressBar = new ProgressBarHelper(header);
    }
  }

  /**
   * Setup event listeners
   */
  private setupEventListeners(): void {
    // Setup compose button
    const composeBtn = this.container.querySelector('.messages-view__compose-btn');
    composeBtn?.addEventListener('click', () => this.openComposeModal());

    // Setup menu trigger
    const menuTrigger = this.container.querySelector('.messages-view__menu-trigger');
    menuTrigger?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMenu();
    });

    // Setup menu items
    const menu = this.container.querySelector('.messages-view__menu');
    menu?.addEventListener('click', (e) => {
      e.stopPropagation();
      const target = e.target as HTMLElement;
      const menuItem = target.closest('.dropdown-menu-item') as HTMLElement;
      if (menuItem) {
        const action = menuItem.dataset.action;
        if (action) {
          this.handleMenuAction(action);
          this.closeMenu();
        }
      }
    });

    // Setup tab click handlers using TabsHelper
    setupTabClickHandlers(this.container, (tabId) => this.handleTabSwitch(tabId as TabFilter));
  }

  /**
   * Handle tab switch
   */
  private handleTabSwitch(tab: TabFilter): void {
    if (this.activeTab === tab) return;

    this.activeTab = tab;

    // Update tab UI and content using TabsHelper
    switchTabWithContent(this.container, tab);

    // Reset pagination for new tab
    this.currentOffset = 0;
    this.hasMoreConversations = true;
    this.conversations = [];

    // Setup infinite scroll for the new active list
    this.setupInfiniteScroll();

    // Load conversations for this tab
    this.loadConversationsBatch();
  }

  /**
   * Setup infinite scroll on the active list container
   */
  private setupInfiniteScroll(): void {
    const list = this.container.querySelector(`[data-list="${this.activeTab}"]`);
    if (list) {
      this.infiniteScroll.observe(list as HTMLElement);
    }
  }

  /**
   * Load initial data - start DM service (which fetches messages)
   */
  private async loadInitialData(): Promise<void> {
    this.isFetchingDMs = true;
    this.progressBar?.start();

    // Start DM service - this triggers fetchHistoricalMessages
    // which emits dm:fetch-progress and dm:fetch-complete events
    await this.dmService.start();
  }

  /**
   * Handle fetch progress updates
   */
  private handleFetchProgress(data: { current: number; total: number }): void {
    if (data.total > 0) {
      const percent = (data.current / data.total) * 100;
      this.progressBar?.update(percent);

      // Update loading text with progress
      const loadingEl = this.container.querySelector(`[data-list="${this.activeTab}"] .messages-view__loading`);
      if (loadingEl) {
        loadingEl.textContent = `Loading messages... ${data.current}/${data.total}`;
      }
    }
  }

  /**
   * Handle fetch completion - load and display conversations
   */
  private async handleFetchComplete(): Promise<void> {
    this.isFetchingDMs = false;
    this.progressBar?.complete();

    // Update badge counts
    await this.updateBadgeCounts();

    // Load conversations for active tab
    await this.loadConversationsBatch();
  }

  /**
   * Update unread badge counts
   */
  private async updateBadgeCounts(): Promise<void> {
    const counts = await this.dmService.getUnreadCountsSplit();

    // Update known badge
    const knownBadge = this.container.querySelector('[data-badge="known"]') as HTMLElement;
    if (knownBadge) {
      if (counts.known > 0) {
        knownBadge.textContent = counts.known.toString();
        knownBadge.style.display = 'inline-flex';
      } else {
        knownBadge.style.display = 'none';
      }
    }

    // Update unknown badge
    const unknownBadge = this.container.querySelector('[data-badge="unknown"]') as HTMLElement;
    if (unknownBadge) {
      if (counts.unknown > 0) {
        unknownBadge.textContent = counts.unknown.toString();
        unknownBadge.style.display = 'inline-flex';
      } else {
        unknownBadge.style.display = 'none';
      }
    }
  }

  /**
   * Handle load more (infinite scroll trigger)
   */
  private async handleLoadMore(): Promise<void> {
    if (this.isLoading || !this.hasMoreConversations) return;
    await this.loadConversationsBatch();
  }

  /**
   * Refresh conversations without showing loading state (for live updates)
   */
  private async refreshConversationsQuiet(): Promise<void> {
    // Update badge counts
    await this.updateBadgeCounts();

    // Reset pagination
    this.currentOffset = 0;
    this.hasMoreConversations = true;
    this.conversations = [];

    // Reload without clearing UI first (prevents flicker)
    await this.loadConversationsBatch();
  }

  /**
   * Load a batch of conversations
   */
  private async loadConversationsBatch(): Promise<void> {
    if (this.isLoading) return;
    this.isLoading = true;

    const isInitialLoad = this.currentOffset === 0;
    const list = this.container.querySelector(`[data-list="${this.activeTab}"]`);

    try {
      // Show loading indicator for subsequent loads (not initial)
      if (!isInitialLoad) {
        this.infiniteScroll.showLoading();
      }

      // Get batch of conversations filtered by tab
      const batch = await this.dmService.getConversationsFiltered(
        this.activeTab,
        BATCH_SIZE,
        this.currentOffset
      );

      // Check if we have more
      if (batch.length < BATCH_SIZE) {
        this.hasMoreConversations = false;
      }

      // Add to our list
      this.conversations.push(...batch);
      this.currentOffset += batch.length;

      // Render the batch
      await this.renderConversationsBatch(batch, isInitialLoad, list as HTMLElement);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (this.conversations.length === 0) {
        this.systemLogger.error('MessagesView', `Failed to load conversations: ${errorMsg}`);
        this.renderError(list as HTMLElement);
      } else {
        this.systemLogger.warn('MessagesView', `Error loading more conversations: ${errorMsg}`);
      }
    } finally {
      this.isLoading = false;
      this.infiniteScroll.hideLoading();
      this.infiniteScroll.refresh();
    }
  }

  /**
   * Render a batch of conversations
   */
  private async renderConversationsBatch(
    batch: DMConversation[],
    isInitialLoad: boolean,
    list: HTMLElement
  ): Promise<void> {
    if (!list) return;

    // Handle empty state
    if (isInitialLoad && batch.length === 0) {
      const emptyMessage = this.activeTab === 'known'
        ? 'No messages from people you follow'
        : 'No messages from unknown users';

      list.innerHTML = `
        <div class="messages-view__empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48">
            <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
            <polyline points="22,6 12,13 2,6"/>
          </svg>
          <p>${emptyMessage}</p>
          <p class="text-muted">Start a conversation by clicking "New Message"</p>
        </div>
      `;
      return;
    }

    // Clear loading message on initial load
    if (isInitialLoad) {
      list.innerHTML = '';
    }

    // Render each conversation item
    const results = await Promise.allSettled(
      batch.map(conv => this.renderConversationItem(conv))
    );

    // Append successful results and setup hover cards for each new item
    const conversationElements = results
      .filter((r): r is PromiseFulfilledResult<HTMLElement> => r.status === 'fulfilled')
      .map(r => r.value);

    conversationElements.forEach(el => {
      list.appendChild(el);
      // Setup hover cards only for this new element
      setupUserMentionHandlers(el);
    });
  }

  /**
   * Render a single conversation item
   */
  private async renderConversationItem(conversation: DMConversation): Promise<HTMLElement> {
    const item = document.createElement('div');
    item.className = 'ui-list__item ui-list__item--clickable conversation-item';
    item.dataset.pubkey = conversation.pubkey;
    if (conversation.unreadCount > 0) {
      item.classList.add('ui-list__item--unread', 'conversation-item--unread');
    }

    // Fetch profile info (with fallback)
    const fallbackName = conversation.pubkey.slice(0, 8) + '...';
    let displayName = fallbackName;
    let avatarUrl = '';

    try {
      const profile = await this.userProfileService.getUserProfile(conversation.pubkey);
      if (profile) {
        displayName = profile.display_name || profile.name || fallbackName;
        avatarUrl = profile.picture || '';
      }
    } catch (_err) {
      // Use fallback values
    }

    // Format timestamp
    const timeAgo = formatTimestamp(conversation.lastMessageAt);

    // Avatar: use image if available, otherwise letter placeholder
    // Wrap in user-mention for hover card support
    const avatarHtml = avatarUrl
      ? `<div class="user-mention conversation-item__avatar" data-pubkey="${conversation.pubkey}"><img class="conversation-item__avatar-img" src="${avatarUrl}" alt="" /></div>`
      : `<div class="user-mention conversation-item__avatar-placeholder" data-pubkey="${conversation.pubkey}">${displayName.charAt(0).toUpperCase()}</div>`;

    // Only avatar and name trigger hover card
    item.innerHTML = `
      <div class="conversation-item__user">
        ${avatarHtml}
        <div class="conversation-item__content">
          <div class="conversation-item__header">
            <span class="user-mention conversation-item__name" data-pubkey="${conversation.pubkey}">${escapeHtml(displayName)}</span>
            ${timeAgo}
          </div>
          <div class="conversation-item__preview">
            ${escapeHtml(conversation.lastMessagePreview)}
          </div>
        </div>
      </div>
      ${conversation.unreadCount > 0 ? `
        <div class="badge">${conversation.unreadCount}</div>
      ` : ''}
    `;

    // Click handler to open conversation
    item.addEventListener('click', () => {
      this.openConversation(conversation.pubkey);
    });

    return item;
  }

  /**
   * Open a conversation
   */
  private openConversation(partnerPubkey: string): void {
    // Mark as read
    this.dmService.markAsRead(partnerPubkey);

    // Navigate to conversation view
    this.router.navigate(`/messages/${partnerPubkey}`);
  }

  /**
   * Open compose modal for new message
   */
  private openComposeModal(): void {
    const modal = new DMComposeModal();
    modal.show();
  }

  /**
   * Render error state
   */
  private renderError(list: HTMLElement): void {
    if (!list) return;

    list.innerHTML = `
      <div class="messages-view__error">
        <p>Failed to load messages</p>
        <button class="btn btn--medium" onclick="location.reload()">Retry</button>
      </div>
    `;
  }


  /**
   * Toggle menu visibility
   */
  private toggleMenu(): void {
    if (this.menuOpen) {
      this.closeMenu();
    } else {
      this.openMenu();
    }
  }

  /**
   * Open menu
   */
  private openMenu(): void {
    const menu = this.container.querySelector('.messages-view__menu') as HTMLElement;
    if (!menu) return;

    menu.style.display = 'block';
    this.menuOpen = true;
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
    const menu = this.container.querySelector('.messages-view__menu') as HTMLElement;
    if (menu) {
      menu.style.display = 'none';
    }
    this.menuOpen = false;
    document.removeEventListener('click', this.outsideClickHandler);
  }

  /**
   * Position menu below trigger
   */
  private positionMenu(): void {
    const trigger = this.container.querySelector('.messages-view__menu-trigger') as HTMLElement;
    const menu = this.container.querySelector('.messages-view__menu') as HTMLElement;
    if (!trigger || !menu) return;

    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();

    // Position below trigger, aligned to right
    menu.style.position = 'fixed';
    menu.style.top = `${triggerRect.bottom + 4}px`;
    menu.style.left = `${triggerRect.right - menuRect.width}px`;
  }

  /**
   * Handle menu actions
   */
  private async handleMenuAction(action: string): Promise<void> {
    switch (action) {
      case 'mark-all-read':
        await this.dmService.markAllAsRead();
        // Immediately update UI (don't wait for event)
        await this.refreshConversationsQuiet();
        ToastService.show('All messages marked as read', 'success');
        break;
      case 'mark-all-unread':
        await this.dmService.markAllAsUnread();
        // Immediately update UI (don't wait for event)
        await this.refreshConversationsQuiet();
        ToastService.show('All messages marked as unread', 'success');
        break;
    }
  }

  /**
   * Get container element for mounting
   */
  public getElement(): HTMLElement {
    return this.container;
  }

  /**
   * Cleanup on unmount
   */
  public destroy(): void {
    this.closeMenu();
    this.infiniteScroll.destroy();
    this.progressBar?.reset();
    this.subscriptionIds.forEach(id => this.eventBus.off(id));
    this.subscriptionIds = [];
  }
}
