/**
 * BookmarkSecondaryManager
 * Manages bookmark grid view with folders and drag & drop support
 *
 * Features:
 * - Grid layout with cards (3 columns)
 * - Folder support (bookmark categories)
 * - Drag & Drop for reordering and folder assignment
 * - Navigation between root and folder views
 *
 * @purpose Handle bookmark grid rendering, folders, drag & drop, sync operations
 * @used-by MainLayout
 */

import { EventBus } from '../../../services/EventBus';
import { AuthService } from '../../../services/AuthService';
import { ToastService } from '../../../services/ToastService';
import { BookmarkOrchestrator } from '../../../services/orchestration/BookmarkOrchestrator';
import { BookmarkFolderService } from '../../../services/BookmarkFolderService';
import { NostrTransport } from '../../../services/transport/NostrTransport';
import { RelayConfig } from '../../../services/RelayConfig';
import { ListSyncManager } from '../../../services/sync/ListSyncManager';
import { BookmarkStorageAdapter } from '../../../services/sync/adapters/BookmarkStorageAdapter';
import { RestoreListsService } from '../../../services/RestoreListsService';
import { SyncConfirmationModal } from '../../modals/SyncConfirmationModal';
import { renderListSyncButtons } from '../../../helpers/ListSyncButtonsHelper';
import { NewFolderModal } from '../../modals/NewFolderModal';
import { NewBookmarkModal } from '../../modals/NewBookmarkModal';
import { EditBookmarkModal } from '../../modals/EditBookmarkModal';
import { EditFolderModal } from '../../modals/EditFolderModal';
import { BookmarkCard, type BookmarkCardData } from '../../bookmarks/BookmarkCard';
import { FolderCard, type FolderData } from '../../bookmarks/FolderCard';
import { UpNavigator } from '../../bookmarks/UpNavigator';
import { ProfileMountsService } from '../../../services/ProfileMountsService';
import { ProfileMountsOrchestrator } from '../../../services/orchestration/ProfileMountsOrchestrator';
import type { BookmarkItem } from '../../../services/storage/BookmarkFileStorage';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

interface BookmarkWithEvent extends BookmarkItem {
  event?: NostrEvent;
  isPrivate: boolean;
}

export class BookmarkSecondaryManager {
  private containerElement: HTMLElement;
  private eventBus: EventBus;
  private authService: AuthService;
  private bookmarkOrch: BookmarkOrchestrator;
  private folderService: BookmarkFolderService;
  private transport: NostrTransport;
  private relayConfig: RelayConfig;
  private listSyncManager: ListSyncManager<BookmarkItem>;
  private adapter: BookmarkStorageAdapter;
  private profileMountsService: ProfileMountsService;
  private profileMountsOrch: ProfileMountsOrchestrator;

  // View state
  private currentFolderId: string = ''; // '' = root
  private bookmarksCache: Map<string, BookmarkWithEvent> = new Map();
  private isLoading: boolean = false;

  // Event handler for cleanup
  private closeDropdownHandler: ((e: Event) => void) | null = null;

  constructor(containerElement: HTMLElement) {
    this.containerElement = containerElement;
    this.eventBus = EventBus.getInstance();
    this.authService = AuthService.getInstance();
    this.bookmarkOrch = BookmarkOrchestrator.getInstance();
    this.folderService = BookmarkFolderService.getInstance();
    this.transport = NostrTransport.getInstance();
    this.relayConfig = RelayConfig.getInstance();

    this.adapter = new BookmarkStorageAdapter();
    this.listSyncManager = new ListSyncManager(this.adapter);
    this.profileMountsService = ProfileMountsService.getInstance();
    this.profileMountsOrch = ProfileMountsOrchestrator.getInstance();

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    this.eventBus.on('bookmark:updated', () => {
      this.refreshIfActive();
    });

    this.eventBus.on('user:logout', () => {
      this.currentFolderId = '';
      this.bookmarksCache.clear();
    });

    // On user switch, clear cache and refresh if active
    this.eventBus.on('user:login', () => {
      this.currentFolderId = '';
      this.bookmarksCache.clear();
      this.refreshIfActive();
    });

    // Re-render when sync mode changes (Manual <-> Easy)
    this.eventBus.on('list-sync-mode:changed', () => {
      this.refreshIfActive();
    });
  }

  private refreshIfActive(): void {
    const listTab = this.containerElement.querySelector('[data-tab-content="list-bookmarks"]');
    if (listTab && listTab.classList.contains('tab-content--active')) {
      this.renderBookmarksTab(listTab as HTMLElement);
    }
  }

  /**
   * Handle tab switch (called by MainLayout)
   */
  public handleTabSwitch(tabName: string, content: HTMLElement): void {
    if (tabName === 'bookmarks') {
      this.renderBookmarksTab(content);
    }
  }

  /**
   * Public render method (called by MainLayout)
   */
  public async renderListTab(container: HTMLElement): Promise<void> {
    await this.renderBookmarksTab(container);
  }

  /**
   * Main render function
   */
  private async renderBookmarksTab(container: HTMLElement): Promise<void> {
    const currentUser = this.authService.getCurrentUser();

    if (!currentUser) {
      container.innerHTML = `
        <div class="bookmarks-empty-state">
          <p>Log in to see your bookmarks</p>
        </div>
      `;
      return;
    }

    // Show loading
    container.innerHTML = `
      <div class="bookmarks-loading">Loading bookmarks...</div>
    `;

    try {
      // Fetch all bookmarks from browser storage
      await this.loadBookmarks();

      // Render the view
      await this.renderCurrentView(container);
    } catch (error) {
      console.error('Failed to render bookmarks:', error);
      container.innerHTML = `
        <div class="bookmarks-empty-state">
          <p>Failed to load bookmarks</p>
        </div>
      `;
    }
  }

  /**
   * Load all bookmarks and their events
   */
  private async loadBookmarks(): Promise<void> {
    if (this.isLoading) return;
    this.isLoading = true;

    try {
      // Use RestoreListsService for cascading restore (browser → file → relays)
      const restoreService = RestoreListsService.getInstance();
      const result = await restoreService.restoreIfEmpty(
        this.listSyncManager,
        () => this.adapter.getBrowserItems(),
        (items) => this.adapter.setBrowserItems(items),
        'Bookmarks',
        async () => {
          // Restore folder data before file restore
          await this.adapter.restoreFolderDataFromFile();
        },
        async (syncResult) => {
          // After relay sync: create folders from categories and assign bookmarks
          if (syncResult.categoryAssignments && syncResult.categoryAssignments.size > 0) {
            const existingFolders = this.folderService.getFolders();

            // Collect categories that have items (skip empty string = root)
            const categoriesWithItems = new Set<string>();
            for (const [, categoryName] of syncResult.categoryAssignments) {
              if (categoryName !== '') {
                categoriesWithItems.add(categoryName);
              }
            }

            // Create folders for new categories
            for (const categoryName of categoriesWithItems) {
              const existingFolder = existingFolders.find(f => f.name === categoryName);
              if (!existingFolder) {
                this.folderService.createFolder(categoryName);
                console.log(`[BookmarkSecondaryManager] Created folder from relay: "${categoryName}"`);
              }
            }

            // Assign bookmarks to their categories from relay
            const updatedFolders = this.folderService.getFolders();
            for (const [bookmarkId, categoryName] of syncResult.categoryAssignments) {
              if (categoryName === '') {
                // Root - ensure assignment exists
                this.folderService.ensureBookmarkAssignment(bookmarkId);
              } else {
                // Find folder by name and move bookmark there
                const folder = updatedFolders.find(f => f.name === categoryName);
                if (folder) {
                  this.folderService.moveBookmarkToFolder(bookmarkId, folder.id);
                }
              }
            }

            console.log(`[BookmarkSecondaryManager] Restored ${categoriesWithItems.size} folders from relays`);
          }
        }
      );

      if (result.source === 'empty') {
        this.bookmarksCache.clear();
        return;
      }

      const bookmarksFromBrowser = this.adapter.getBrowserItems();
      if (bookmarksFromBrowser.length === 0) {
        this.bookmarksCache.clear();
        return;
      }

      // Sort bookmarks by addedAt DESC (newest first) for initial display
      const sortedBookmarks = [...bookmarksFromBrowser].sort((a, b) => {
        const timeA = a.addedAt || 0;
        const timeB = b.addedAt || 0;
        return timeB - timeA; // DESC - newest first
      });

      // Fetch events from relays (only for 'e' type bookmarks - event references)
      // Other types like 'r' (URLs), 't' (hashtags), 'a' (replaceable events) are not fetchable by ID
      const relays = this.relayConfig.getAllRelays().map(r => r.url);
      const eventBookmarks = sortedBookmarks.filter(b => b.type === 'e');
      const events = eventBookmarks.length > 0
        ? await this.transport.fetch(relays, [{
            ids: eventBookmarks.map(b => b.id)
          }], 5000)
        : [];

      // Build cache
      const eventMap = new Map<string, NostrEvent>();
      events.forEach(e => eventMap.set(e.id, e));

      this.bookmarksCache.clear();

      // Check if this is first initialization (no root order yet)
      const isFirstInit = !this.folderService.hasRootOrder();

      // Process in sorted order (newest first)
      for (const bookmark of sortedBookmarks) {
        const event = eventMap.get(bookmark.id);
        this.bookmarksCache.set(bookmark.id, {
          ...bookmark,
          event,
          isPrivate: (bookmark as BookmarkItem & { isPrivate?: boolean }).isPrivate || false
        });

        // Ensure folder assignment exists
        this.folderService.ensureBookmarkAssignment(bookmark.id);
      }

      // On first init, build root order from sorted bookmarks (newest first)
      if (isFirstInit) {
        const rootOrder: Array<{ type: 'folder' | 'bookmark'; id: string }> = [];
        for (const bookmark of sortedBookmarks) {
          rootOrder.push({ type: 'bookmark', id: bookmark.id });
        }
        this.folderService.saveRootOrder(rootOrder);
      }
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Render current view (root or folder)
   */
  private async renderCurrentView(container: HTMLElement): Promise<void> {
    const isInFolder = this.currentFolderId !== '';
    const folder = isInFolder ? this.folderService.getFolder(this.currentFolderId) : null;

    // Build HTML structure
    container.innerHTML = `
      ${this.renderSyncControls()}
      ${this.renderHeader(folder)}
      ${isInFolder ? this.renderBreadcrumb(folder) : ''}
      <div class="bookmark-grid"></div>
      ${this.renderSyncControls()}
    `;

    // Bind sync buttons
    this.bindSyncButtons(container);

    // Bind header buttons
    this.bindHeaderButtons(container);

    // Render grid content
    const grid = container.querySelector('.bookmark-grid') as HTMLElement;
    await this.renderGridContent(grid);
  }

  /**
   * Render sync controls based on sync mode (Manual vs Easy)
   */
  private renderSyncControls(): string {
    return renderListSyncButtons();
  }

  /**
   * Render header with New dropdown button
   */
  private renderHeader(folder: { id: string; name: string } | null): string {
    const title = folder ? folder.name : 'Bookmarks';

    return `
      <div class="bookmark-header">
        <span class="bookmark-header__title">${this.escapeHtml(title)}</span>
        <div class="bookmark-header__new-dropdown">
            <button class="bookmark-header__new-btn" title="Create new item">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 5V19M5 12H19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
              New
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" class="bookmark-header__new-chevron">
                <path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>
            <div class="bookmark-header__dropdown-menu">
              <button class="bookmark-header__dropdown-item" data-action="new-folder">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path d="M3 7C3 5.89543 3.89543 5 5 5H9.58579C9.851 5 10.1054 5.10536 10.2929 5.29289L12 7H19C20.1046 7 21 7.89543 21 9V17C21 18.1046 20.1046 19 19 19H5C3.89543 19 3 18.1046 3 17V7Z" stroke="currentColor" stroke-width="1.5"/>
                </svg>
                Folder
              </button>
              <button class="bookmark-header__dropdown-item" data-action="new-bookmark">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                  <path d="M10.172 13.828a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
                Bookmark
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Render breadcrumb navigation
   */
  private renderBreadcrumb(folder: { id: string; name: string } | null): string {
    if (!folder) return '';

    return `
      <div class="bookmark-breadcrumb">
        <span class="bookmark-breadcrumb__item" data-navigate="root">Bookmarks</span>
        <span class="bookmark-breadcrumb__separator">/</span>
        <span class="bookmark-breadcrumb__item bookmark-breadcrumb__item--current">${this.escapeHtml(folder.name)}</span>
      </div>
    `;
  }

  /**
   * Render grid content (cards)
   */
  private async renderGridContent(grid: HTMLElement): Promise<void> {
    grid.innerHTML = '';

    if (this.currentFolderId !== '') {
      // In a folder - show up navigator first
      const upNav = new UpNavigator({
        onClick: () => this.navigateToRoot(),
        onDrop: async (bookmarkId) => {
          await this.moveBookmarkToFolder(bookmarkId, '');
        }
      });
      grid.appendChild(upNav.render());

      // Get bookmarks in this folder
      const bookmarkIds = this.folderService.getBookmarksInFolder(this.currentFolderId);
      for (const bookmarkId of bookmarkIds) {
        const bookmark = this.bookmarksCache.get(bookmarkId);
        if (bookmark) {
          const card = await this.createBookmarkCard(bookmark);
          grid.appendChild(card);
        }
      }
    } else {
      // Root view - mixed folders and bookmarks
      const rootOrder = this.folderService.getRootOrder();
      const renderedIds = new Set<string>();

      for (const item of rootOrder) {
        if (item.type === 'folder') {
          const folder = this.folderService.getFolder(item.id);
          if (folder) {
            const card = this.createFolderCard(folder);
            grid.appendChild(card);
            renderedIds.add(item.id);
          }
        } else if (item.type === 'bookmark') {
          const bookmark = this.bookmarksCache.get(item.id);
          // Only show if in root (no folder assignment)
          const folderId = this.folderService.getBookmarkFolder(item.id);
          if (bookmark && folderId === '') {
            const card = await this.createBookmarkCard(bookmark);
            grid.appendChild(card);
            renderedIds.add(item.id);
          }
        }
      }

      // Add any new items not in root order yet
      const folders = this.folderService.getFolders();
      for (const folder of folders) {
        if (!renderedIds.has(folder.id)) {
          const card = this.createFolderCard(folder);
          grid.appendChild(card);
          this.folderService.addToRootOrder('folder', folder.id);
        }
      }

      for (const [bookmarkId, bookmark] of this.bookmarksCache) {
        const folderId = this.folderService.getBookmarkFolder(bookmarkId);
        if (folderId === '' && !renderedIds.has(bookmarkId)) {
          const card = await this.createBookmarkCard(bookmark);
          grid.appendChild(card);
          this.folderService.addToRootOrder('bookmark', bookmarkId);
        }
      }
    }

    // Check empty state
    if (grid.children.length === 0 || (this.currentFolderId === '' && grid.children.length === 0)) {
      grid.innerHTML = `
        <div class="bookmarks-empty-state" style="grid-column: 1 / -1;">
          <p>No bookmarks yet</p>
        </div>
      `;
    }

    // Setup drag & drop for reordering
    this.setupGridDragDrop(grid);
  }

  /**
   * Create a bookmark card
   */
  private async createBookmarkCard(bookmark: BookmarkWithEvent): Promise<HTMLElement> {
    const cardData: BookmarkCardData = {
      id: bookmark.id,
      type: bookmark.type,
      value: bookmark.value,
      event: bookmark.event,
      isPrivate: bookmark.isPrivate,
      folderId: this.folderService.getBookmarkFolder(bookmark.id),
      description: bookmark.description
    };

    const card = new BookmarkCard(cardData, {
      onDelete: async (eventId: string) => {
        await this.deleteBookmark(eventId);
      },
      onEdit: (bookmarkId: string) => {
        this.editBookmark(bookmarkId);
      },
      onDragStart: (_eventId: string) => {
        // Drag state tracked internally by setupGridDragDrop
      },
      onDragEnd: () => {
        // Drag state tracked internally by setupGridDragDrop
      }
    });

    return await card.render();
  }

  /**
   * Create a folder card
   */
  private createFolderCard(folder: { id: string; name: string }): HTMLElement {
    const currentUser = this.authService.getCurrentUser();
    const isLoggedIn = !!currentUser;

    const folderData: FolderData = {
      id: folder.id,
      name: folder.name,
      itemCount: this.folderService.getFolderItemCount(folder.id),
      isMounted: isLoggedIn ? this.profileMountsService.isMounted(folder.name) : false
    };

    const card = new FolderCard(folderData, {
      onClick: (folderId) => this.navigateToFolder(folderId),
      onEdit: (folderId) => this.editFolder(folderId),
      onDelete: async (folderId) => {
        await this.deleteFolder(folderId);
      },
      onDrop: async (bookmarkId, folderId) => {
        await this.moveBookmarkToFolder(bookmarkId, folderId);
      },
      onDragStart: (_folderId) => {
        // Drag state tracked internally by setupGridDragDrop
      },
      onDragEnd: () => {
        // Drag state tracked internally by setupGridDragDrop
      },
      showMountCheckbox: isLoggedIn,
      onMountToggle: (_folderId, folderName) => this.handleMountToggle(folderName)
    });

    return card.render();
  }

  /**
   * Handle mount to profile toggle
   */
  private async handleMountToggle(folderName: string): Promise<void> {
    const result = this.profileMountsService.toggleMount(folderName);

    if (result.error) {
      ToastService.show(result.error, 'error');
      // Re-render to reset checkbox state
      const container = this.containerElement.querySelector('[data-tab-content="list-bookmarks"]');
      if (container) {
        this.renderCurrentView(container as HTMLElement);
      }
      return;
    }

    if (result.mounted) {
      ToastService.show(`"${folderName}" mounted to profile`, 'success');
    } else {
      ToastService.show(`"${folderName}" unmounted from profile`, 'success');
    }

    // Publish to relays (async, don't wait)
    this.profileMountsOrch.publishToRelays().catch(err => {
      console.error('Failed to publish profile mounts:', err);
    });
  }

  /**
   * Setup mouse-based drag & drop for grid reordering
   */
  private setupGridDragDrop(grid: HTMLElement): void {
    let draggedCard: HTMLElement | null = null;
    let draggedId: string | null = null;
    let placeholder: HTMLElement | null = null;
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let offsetX = 0;
    let offsetY = 0;

    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Don't drag if clicking delete button
      if (target.closest('.bookmark-card__delete') || target.closest('.folder-card__delete')) {
        return;
      }

      const card = target.closest('.bookmark-card, .folder-card') as HTMLElement;
      if (!card || card.classList.contains('up-navigator')) return;

      e.preventDefault();
      draggedCard = card;
      draggedId = card.dataset.bookmarkId || card.dataset.folderId || null;
      startX = e.clientX;
      startY = e.clientY;

      const rect = card.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!draggedCard) return;

      const dx = Math.abs(e.clientX - startX);
      const dy = Math.abs(e.clientY - startY);

      // Start dragging after moving 5px
      if (!isDragging && (dx > 5 || dy > 5)) {
        isDragging = true;
        draggedCard.dataset.wasDragging = 'true';
        draggedCard.classList.add('dragging');

        // Create placeholder
        placeholder = document.createElement('div');
        placeholder.className = 'bookmark-card-placeholder';
        placeholder.style.width = draggedCard.offsetWidth + 'px';
        placeholder.style.height = draggedCard.offsetHeight + 'px';
        draggedCard.parentNode?.insertBefore(placeholder, draggedCard);

        // Make card follow mouse
        draggedCard.style.position = 'fixed';
        draggedCard.style.zIndex = '1000';
        draggedCard.style.width = draggedCard.offsetWidth + 'px';
        draggedCard.style.pointerEvents = 'none';
      }

      if (isDragging) {
        draggedCard.style.left = (e.clientX - offsetX) + 'px';
        draggedCard.style.top = (e.clientY - offsetY) + 'px';

        // Find card under cursor
        const elemBelow = document.elementFromPoint(e.clientX, e.clientY);
        const cardBelow = elemBelow?.closest('.bookmark-card:not(.dragging), .folder-card:not(.dragging), .up-navigator') as HTMLElement;

        // Remove previous highlights
        grid.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));

        if (cardBelow && cardBelow !== placeholder) {
          cardBelow.classList.add('drag-over');
        }
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      if (!draggedCard || !isDragging) {
        draggedCard = null;
        isDragging = false;
        return;
      }

      // Find drop target BEFORE restoring pointer events
      // Hide dragged card temporarily to find element below
      const savedDisplay = draggedCard.style.display;
      draggedCard.style.display = 'none';
      const elemBelow = document.elementFromPoint(e.clientX, e.clientY);
      draggedCard.style.display = savedDisplay;
      const dropTarget = elemBelow?.closest('.bookmark-card, .folder-card, .up-navigator') as HTMLElement;

      // Reset dragged card style
      draggedCard.classList.remove('dragging');
      draggedCard.style.position = '';
      draggedCard.style.zIndex = '';
      draggedCard.style.width = '';
      draggedCard.style.left = '';
      draggedCard.style.top = '';
      draggedCard.style.pointerEvents = '';

      // Remove highlights
      grid.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));

      // Remove placeholder
      placeholder?.remove();
      placeholder = null;

      if (dropTarget && draggedId && draggedCard) {
        const targetId = dropTarget.dataset.bookmarkId || dropTarget.dataset.folderId;
        const isDraggingBookmark = draggedCard.classList.contains('bookmark-card');
        const isDraggingFolder = draggedCard.classList.contains('folder-card');
        const isTargetFolder = dropTarget.classList.contains('folder-card');
        const isTargetUpNav = dropTarget.classList.contains('up-navigator');

        if (isTargetUpNav && isDraggingBookmark) {
          // Move bookmark to root (from folder)
          this.moveBookmarkToFolder(draggedId, '');
        } else if (isTargetFolder && isDraggingBookmark && targetId) {
          // Move bookmark into folder
          this.moveBookmarkToFolder(draggedId, targetId);
        } else if (targetId && targetId !== draggedId) {
          // Reorder
          if (this.currentFolderId && isDraggingBookmark) {
            // Inside a folder - reorder bookmarks within folder
            const bookmarksInFolder = this.folderService.getBookmarksInFolder(this.currentFolderId);
            const targetIndex = bookmarksInFolder.findIndex(id => id === targetId);
            if (targetIndex !== -1) {
              this.folderService.moveItemToPosition(draggedId, targetIndex);
              grid.insertBefore(draggedCard, dropTarget);
            }
          } else {
            // Root level - use root order
            const draggedType = isDraggingFolder ? 'folder' : 'bookmark';
            const rootOrder = this.folderService.getRootOrder();
            const targetIndex = rootOrder.findIndex(item => item.id === targetId);
            if (targetIndex !== -1) {
              this.folderService.moveInRootOrder(draggedType as 'folder' | 'bookmark', draggedId, targetIndex);
              grid.insertBefore(draggedCard, dropTarget);
            }
          }
        }
      }

      draggedCard = null;
      draggedId = null;
      isDragging = false;
    };

    grid.addEventListener('mousedown', onMouseDown);
  }

  // ========================================
  // Navigation
  // ========================================

  private navigateToFolder(folderId: string): void {
    this.currentFolderId = folderId;
    const container = this.containerElement.querySelector('[data-tab-content="list-bookmarks"]');
    if (container) {
      this.renderCurrentView(container as HTMLElement);
    }
  }

  private navigateToRoot(): void {
    this.currentFolderId = '';
    const container = this.containerElement.querySelector('[data-tab-content="list-bookmarks"]');
    if (container) {
      this.renderCurrentView(container as HTMLElement);
    }
  }

  // ========================================
  // Actions
  // ========================================

  private async deleteBookmark(eventId: string): Promise<void> {
    const isPrivate = this.bookmarkOrch.isPrivateBookmarksEnabled();

    try {
      // Remove from files
      await this.bookmarkOrch.removeBookmark(eventId, isPrivate);

      // Remove from browser storage
      const currentItems = this.adapter.getBrowserItems();
      const updatedItems = currentItems.filter(b => b.id !== eventId);
      this.adapter.setBrowserItems(updatedItems);

      // Remove folder assignment
      this.folderService.removeBookmarkAssignment(eventId);
      this.folderService.removeFromRootOrder('bookmark', eventId);

      // Remove from cache
      this.bookmarksCache.delete(eventId);

      ToastService.show('Bookmark removed', 'success');
      // Note: Card is already removed from DOM by BookmarkCard.ts via card.remove()
      // Don't emit bookmark:updated to avoid full re-render
    } catch (error) {
      console.error('Failed to delete bookmark:', error);
      ToastService.show('Failed to remove bookmark', 'error');
    }
  }

  private editBookmark(bookmarkId: string): void {
    const bookmark = this.bookmarksCache.get(bookmarkId);
    if (!bookmark || bookmark.type !== 'r') return;

    const modal = new EditBookmarkModal({
      url: bookmark.value || bookmark.id,
      description: bookmark.description || '',
      onSave: (newUrl, newDescription) => {
        try {
          // Update in browser storage
          const currentItems = this.adapter.getBrowserItems();
          const updatedItems = currentItems.map(item => {
            if (item.id === bookmarkId) {
              return {
                ...item,
                id: newUrl,
                value: newUrl,
                description: newDescription || undefined
              };
            }
            return item;
          });
          this.adapter.setBrowserItems(updatedItems);

          // Update cache
          const cachedBookmark = this.bookmarksCache.get(bookmarkId);
          if (cachedBookmark) {
            this.bookmarksCache.delete(bookmarkId);
            this.bookmarksCache.set(newUrl, {
              ...cachedBookmark,
              id: newUrl,
              value: newUrl,
              description: newDescription || undefined
            });
          }

          // Update folder assignment if URL changed
          if (bookmarkId !== newUrl) {
            const folderId = this.folderService.getBookmarkFolder(bookmarkId);
            this.folderService.removeBookmarkAssignment(bookmarkId);
            if (folderId) {
              this.folderService.moveBookmarkToFolder(newUrl, folderId);
            } else {
              this.folderService.ensureBookmarkAssignment(newUrl);
              this.folderService.removeFromRootOrder('bookmark', bookmarkId);
              this.folderService.addToRootOrder('bookmark', newUrl);
            }
          }

          ToastService.show('Bookmark updated', 'success');

          // Refresh view
          const container = this.containerElement.querySelector('[data-tab-content="list-bookmarks"]');
          if (container) {
            this.renderCurrentView(container as HTMLElement);
          }
        } catch (error) {
          console.error('Failed to update bookmark:', error);
          ToastService.show('Failed to update bookmark', 'error');
        }
      }
    });

    modal.show();
  }

  private editFolder(folderId: string): void {
    const folder = this.folderService.getFolder(folderId);
    if (!folder) return;

    const modal = new EditFolderModal({
      currentName: folder.name,
      onSave: (newName) => {
        try {
          // Rename folder
          this.folderService.renameFolder(folderId, newName);

          // Update profile mount reference if folder was mounted
          this.profileMountsService.handleFolderRename(folder.name, newName);

          // Update category in all bookmarks assigned to this folder
          const currentItems = this.adapter.getBrowserItems();
          const updatedItems = currentItems.map(item => {
            if (item.category === folder.name) {
              return { ...item, category: newName };
            }
            return item;
          });
          this.adapter.setBrowserItems(updatedItems);

          // Update cache
          for (const [_id, bookmark] of this.bookmarksCache) {
            if (bookmark.category === folder.name) {
              bookmark.category = newName;
            }
          }

          ToastService.show('Folder renamed', 'success');

          // Refresh view
          const container = this.containerElement.querySelector('[data-tab-content="list-bookmarks"]');
          if (container) {
            this.renderCurrentView(container as HTMLElement);
          }
        } catch (error) {
          console.error('Failed to rename folder:', error);
          ToastService.show('Failed to rename folder', 'error');
        }
      }
    });

    modal.show();
  }

  private async deleteFolder(folderId: string): Promise<void> {
    try {
      // Get folder name before deletion (needed to update category in storage)
      const folder = this.folderService.getFolder(folderId);
      const folderName = folder?.name || '';

      // Remove from profile mounts if mounted
      this.profileMountsService.handleFolderDelete(folderName);

      // Delete folder (moves items to root)
      const affectedIds = this.folderService.deleteFolder(folderId);

      // Remove from root order
      this.folderService.removeFromRootOrder('folder', folderId);

      // Add affected bookmarks back to root order
      affectedIds.forEach(id => {
        this.folderService.addToRootOrder('bookmark', id);
      });

      // Update category in browser storage (set to '' for root)
      const currentItems = this.adapter.getBrowserItems();
      const updatedItems = currentItems.map(item => {
        if (item.category === folderName) {
          return { ...item, category: '' };
        }
        return item;
      });
      this.adapter.setBrowserItems(updatedItems);

      // Update cache
      for (const [_id, bookmark] of this.bookmarksCache) {
        if (bookmark.category === folderName) {
          bookmark.category = '';
        }
      }

      ToastService.show('Folder deleted, bookmarks moved to root', 'success');

      // Refresh view
      const container = this.containerElement.querySelector('[data-tab-content="list-bookmarks"]');
      if (container) {
        this.renderCurrentView(container as HTMLElement);
      }
    } catch (error) {
      console.error('Failed to delete folder:', error);
      ToastService.show('Failed to delete folder', 'error');
    }
  }

  private async moveBookmarkToFolder(bookmarkId: string, targetFolderId: string): Promise<void> {
    try {
      const currentFolderId = this.folderService.getBookmarkFolder(bookmarkId);

      // Don't move if already in target folder
      if (currentFolderId === targetFolderId) return;

      // Get target folder name for category
      const targetFolder = targetFolderId ? this.folderService.getFolder(targetFolderId) : null;
      const targetCategoryName = targetFolder?.name || '';

      // Update assignment
      this.folderService.moveBookmarkToFolder(bookmarkId, targetFolderId);

      // Update root order
      if (currentFolderId === '' && targetFolderId !== '') {
        // Moving from root to folder - remove from root order
        this.folderService.removeFromRootOrder('bookmark', bookmarkId);
      } else if (currentFolderId !== '' && targetFolderId === '') {
        // Moving from folder to root - add to root order
        this.folderService.addToRootOrder('bookmark', bookmarkId);
      }

      // Update category in browser storage
      const currentItems = this.adapter.getBrowserItems();
      const updatedItems = currentItems.map(item => {
        if (item.id === bookmarkId) {
          return { ...item, category: targetCategoryName };
        }
        return item;
      });
      this.adapter.setBrowserItems(updatedItems);

      // Update cache
      const cachedBookmark = this.bookmarksCache.get(bookmarkId);
      if (cachedBookmark) {
        cachedBookmark.category = targetCategoryName;
      }

      const targetName = targetFolderId === '' ? 'root' : targetFolder?.name || 'folder';
      ToastService.show(`Moved to ${targetName}`, 'success');

      // Just remove the card from DOM - it's now in a different folder/root
      const card = this.containerElement.querySelector(`[data-bookmark-id="${bookmarkId}"]`);
      card?.remove();

      // Update folder item count if moving into a folder
      if (targetFolderId !== '') {
        const folderCard = this.containerElement.querySelector(`[data-folder-id="${targetFolderId}"]`);
        const countEl = folderCard?.querySelector('.folder-card__count');
        if (countEl) {
          const newCount = this.folderService.getFolderItemCount(targetFolderId);
          countEl.textContent = `${newCount} ${newCount === 1 ? 'item' : 'items'}`;
        }
      }
    } catch (error) {
      console.error('Failed to move bookmark:', error);
      ToastService.show('Failed to move bookmark', 'error');
    }
  }

  private createNewFolder(): void {
    const modal = new NewFolderModal({
      onConfirm: (name) => {
        try {
          const folder = this.folderService.createFolder(name);
          this.folderService.addToRootOrder('folder', folder.id);

          // Add folder card to grid at the beginning without full re-render
          const grid = this.containerElement.querySelector('.bookmark-grid');
          if (grid) {
            const card = this.createFolderCard(folder);
            grid.insertBefore(card, grid.firstChild);
          }

          ToastService.show(`Folder "${name}" created`, 'success');
        } catch (error) {
          console.error('Failed to create folder:', error);
          ToastService.show('Failed to create folder', 'error');
        }
      }
    });

    modal.show();
  }

  private createNewBookmark(): void {
    const modal = new NewBookmarkModal({
      onConfirm: async (url, description, folderId, newFolderName) => {
        try {
          let targetFolderId = folderId;
          let categoryName = '';

          // Create new folder if requested
          if (folderId === '__new__' && newFolderName) {
            const folder = this.folderService.createFolder(newFolderName);
            this.folderService.addToRootOrder('folder', folder.id);
            targetFolderId = folder.id;
            categoryName = newFolderName;
          } else if (folderId && folderId !== '') {
            // Get category name from existing folder
            const folder = this.folderService.getFolder(folderId);
            categoryName = folder?.name || '';
          }

          // Create bookmark item
          const bookmarkItem: BookmarkItem = {
            id: url, // For URL bookmarks, ID is the URL
            type: 'r',
            value: url,
            addedAt: Math.floor(Date.now() / 1000),
            isPrivate: false,
            category: categoryName,
            description: description || undefined
          };

          // Add to browser storage
          const currentItems = this.adapter.getBrowserItems();
          if (currentItems.some(b => b.id === url)) {
            ToastService.show('This URL is already bookmarked', 'info');
            return;
          }
          this.adapter.setBrowserItems([...currentItems, bookmarkItem]);

          // Add to cache
          this.bookmarksCache.set(url, {
            ...bookmarkItem,
            event: undefined,
            isPrivate: false
          });

          // Assign to folder
          if (targetFolderId && targetFolderId !== '') {
            this.folderService.moveBookmarkToFolder(url, targetFolderId);
          } else {
            this.folderService.ensureBookmarkAssignment(url);
            this.folderService.addToRootOrder('bookmark', url);
          }

          ToastService.show('Bookmark created', 'success');

          // Refresh view
          const container = this.containerElement.querySelector('[data-tab-content="list-bookmarks"]');
          if (container) {
            this.renderCurrentView(container as HTMLElement);
          }
        } catch (error) {
          console.error('Failed to create bookmark:', error);
          ToastService.show('Failed to create bookmark', 'error');
        }
      }
    });

    modal.show();
  }

  // ========================================
  // Sync Handlers
  // ========================================

  private bindSyncButtons(container: HTMLElement): void {
    container.querySelectorAll('.sync-from-relays-btn').forEach(btn => {
      btn.addEventListener('click', () => this.handleSyncFromRelays(container));
    });

    container.querySelectorAll('.sync-to-relays-btn').forEach(btn => {
      btn.addEventListener('click', () => this.handleSyncToRelays());
    });

    container.querySelectorAll('.save-to-file-btn').forEach(btn => {
      btn.addEventListener('click', () => this.handleSaveToFile());
    });

    container.querySelectorAll('.restore-from-file-btn').forEach(btn => {
      btn.addEventListener('click', () => this.handleRestoreFromFile(container));
    });
  }

  private bindHeaderButtons(container: HTMLElement): void {
    // New dropdown toggle
    const newBtn = container.querySelector('.bookmark-header__new-btn');
    const dropdown = container.querySelector('.bookmark-header__new-dropdown');

    newBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown?.classList.toggle('bookmark-header__new-dropdown--open');
    });

    // Remove previous closeDropdown listener if exists
    if (this.closeDropdownHandler) {
      document.removeEventListener('click', this.closeDropdownHandler);
    }

    // Close dropdown when clicking outside
    this.closeDropdownHandler = (e: Event) => {
      if (!dropdown?.contains(e.target as Node)) {
        dropdown?.classList.remove('bookmark-header__new-dropdown--open');
      }
    };
    document.addEventListener('click', this.closeDropdownHandler);

    // Dropdown actions
    const folderItem = container.querySelector('[data-action="new-folder"]');
    const bookmarkItem = container.querySelector('[data-action="new-bookmark"]');

    folderItem?.addEventListener('click', () => {
      dropdown?.classList.remove('bookmark-header__new-dropdown--open');
      this.createNewFolder();
    });

    bookmarkItem?.addEventListener('click', () => {
      dropdown?.classList.remove('bookmark-header__new-dropdown--open');
      this.createNewBookmark();
    });

    // Breadcrumb navigation
    const rootLink = container.querySelector('[data-navigate="root"]');
    rootLink?.addEventListener('click', () => this.navigateToRoot());
  }

  private async handleSyncFromRelays(container: HTMLElement): Promise<void> {
    try {
      ToastService.show('Fetching from relays...', 'info');

      const result = await this.listSyncManager.syncFromRelays();

      console.log('[BookmarkSecondaryManager] Sync result:', {
        itemCount: result.relayItems.length,
        hasCategoryAssignments: !!result.categoryAssignments,
        categoryAssignmentsSize: result.categoryAssignments?.size || 0,
        categories: result.categories
      });

      // Helper to apply folder assignments after sync
      const applyFolderAssignments = () => {
        if (!result.categoryAssignments) {
          console.log('[BookmarkSecondaryManager] No categoryAssignments in result');
          return;
        }

        // Collect categories that actually have items
        const categoriesWithItems = new Set<string>();
        for (const [bookmarkId, categoryName] of result.categoryAssignments) {
          console.log(`[applyFolderAssignments] Bookmark ${bookmarkId.slice(0, 8)} -> category "${categoryName}"`);
          if (categoryName !== '') {
            categoriesWithItems.add(categoryName);
          }
        }
        console.log('[applyFolderAssignments] Categories with items:', Array.from(categoriesWithItems));

        // Create folders only for categories that have items (skip empty ones)
        const existingFolders = this.folderService.getFolders();
        for (const categoryName of categoriesWithItems) {
          const existingFolder = existingFolders.find(f => f.name === categoryName);
          if (!existingFolder) {
            const newFolder = this.folderService.createFolder(categoryName);
            this.folderService.addToRootOrder('folder', newFolder.id);
          }
        }

        // Assign bookmarks to their categories
        const updatedFolders = this.folderService.getFolders();
        for (const [bookmarkId, categoryName] of result.categoryAssignments) {
          if (categoryName === '') {
            // Root - ensure assignment exists
            this.folderService.ensureBookmarkAssignment(bookmarkId);
          } else {
            // Find folder by name and move bookmark there
            const folder = updatedFolders.find(f => f.name === categoryName);
            if (folder) {
              this.folderService.moveBookmarkToFolder(bookmarkId, folder.id);
            }
          }
        }
      };

      if (result.requiresConfirmation) {
        const modal = new SyncConfirmationModal({
          listType: 'Bookmarks',
          added: result.diff.added,
          removed: result.diff.removed,
          getDisplayName: (item) => this.getDisplayNameForSync(item),
          onKeep: async () => {
            await this.listSyncManager.applySyncFromRelays('merge', result.relayItems, result.relayContentWasEmpty);
            applyFolderAssignments();
            ToastService.show(`Merged bookmarks from relays`, 'success');
            await this.loadBookmarks();
            this.renderCurrentView(container);
          },
          onDelete: async () => {
            await this.listSyncManager.applySyncFromRelays('overwrite', result.relayItems, result.relayContentWasEmpty);
            applyFolderAssignments();
            ToastService.show('Synced from relays', 'success');
            await this.loadBookmarks();
            this.renderCurrentView(container);
          }
        });

        await modal.show();
      } else {
        await this.listSyncManager.applySyncFromRelays('merge', result.relayItems, result.relayContentWasEmpty);
        applyFolderAssignments();
        ToastService.show(`Synced from relays`, 'success');
        await this.loadBookmarks();
        this.renderCurrentView(container);
      }
    } catch (error) {
      console.error('Failed to sync from relays:', error);
      ToastService.show('Failed to sync from relays', 'error');
    }
  }

  private async handleSyncToRelays(): Promise<void> {
    try {
      ToastService.show('Publishing to relays...', 'info');
      await this.listSyncManager.syncToRelays();
      ToastService.show('Bookmarks published successfully', 'success');
    } catch (error) {
      console.error('Failed to publish to relays:', error);
      ToastService.show('Failed to publish to relays', 'error');
    }
  }

  private async handleSaveToFile(): Promise<void> {
    try {
      ToastService.show('Saving to file...', 'info');
      await this.listSyncManager.saveToFile();
      ToastService.show('Saved to local file', 'success');
    } catch (error) {
      console.error('Failed to save to file:', error);
      ToastService.show('Failed to save to file', 'error');
    }
  }

  private async handleRestoreFromFile(container: HTMLElement): Promise<void> {
    try {
      ToastService.show('Restoring from file...', 'info');

      // Restore folder data first (before items)
      await this.adapter.restoreFolderDataFromFile();

      // Then restore bookmark items
      await this.listSyncManager.restoreFromFile();

      // Apply category assignments from restored items
      const restoredItems = this.adapter.getBrowserItems();
      const existingFolders = this.folderService.getFolders();

      // Create folders for categories that don't exist yet
      const categories = new Set<string>();
      for (const item of restoredItems) {
        if (item.category && item.category !== '') {
          categories.add(item.category);
        }
      }

      for (const categoryName of categories) {
        const existingFolder = existingFolders.find(f => f.name === categoryName);
        if (!existingFolder) {
          const newFolder = this.folderService.createFolder(categoryName);
          this.folderService.addToRootOrder('folder', newFolder.id);
        }
      }

      // Assign bookmarks to their categories
      const updatedFolders = this.folderService.getFolders();
      for (const item of restoredItems) {
        const categoryName = item.category || '';
        if (categoryName === '') {
          // Root - ensure assignment exists
          this.folderService.ensureBookmarkAssignment(item.id);
        } else {
          // Find folder by name and move bookmark there
          const folder = updatedFolders.find(f => f.name === categoryName);
          if (folder) {
            this.folderService.moveBookmarkToFolder(item.id, folder.id);
          }
        }
      }

      ToastService.show('Restored from local file', 'success');
      await this.loadBookmarks();
      this.renderCurrentView(container);
    } catch (error) {
      console.error('Failed to restore from file:', error);
      ToastService.show('Failed to restore from file', 'error');
    }
  }

  private async getDisplayNameForSync(item: BookmarkItem): Promise<string> {
    try {
      const relays = this.relayConfig.getAllRelays().map(r => r.url);
      const events = await this.transport.fetch(relays, [{ ids: [item.id] }], 3000);

      if (events.length === 0) {
        return item.id.slice(0, 12) + '...';
      }

      const event = events[0];
      const snippet = event.content.slice(0, 60);
      return snippet || item.id.slice(0, 12) + '...';
    } catch {
      return item.id.slice(0, 12) + '...';
    }
  }

  // ========================================
  // Helpers
  // ========================================

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  public destroy(): void {
    // Remove global click listener
    if (this.closeDropdownHandler) {
      document.removeEventListener('click', this.closeDropdownHandler);
      this.closeDropdownHandler = null;
    }
  }
}
