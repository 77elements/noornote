/**
 * TribeSecondaryManager
 * Manages tribe grid view with folders and drag & drop support
 *
 * Features:
 * - Grid layout with member cards
 * - Folder support (tribe categories)
 * - Drag & Drop for reordering and folder assignment
 * - Navigation between root and folder views
 *
 * @purpose Handle tribe grid rendering, folders, drag & drop, sync operations
 * @used-by MainLayout
 */

import { EventBus } from '../../../services/EventBus';
import { AuthService } from '../../../services/AuthService';
import { ToastService } from '../../../services/ToastService';
import { ModalService } from '../../../services/ModalService';
import { TribeOrchestrator } from '../../../services/orchestration/TribeOrchestrator';
import { TribeFolderService } from '../../../services/TribeFolderService';
import { ListSyncManager } from '../../../services/sync/ListSyncManager';
import { TribeStorageAdapter } from '../../../services/sync/adapters/TribeStorageAdapter';
import { RestoreListsService } from '../../../services/RestoreListsService';
import { SyncConfirmationModal } from '../../modals/SyncConfirmationModal';
import { renderListSyncButtons } from '../../../helpers/ListSyncButtonsHelper';
import { NewFolderModal } from '../../modals/NewFolderModal';
import { TribeMemberCard } from '../../tribes/TribeMemberCard';
import { FolderCard, type FolderData } from '../../bookmarks/FolderCard';
import { UpNavigator } from '../../bookmarks/UpNavigator';
import { UserProfileService } from '../../../services/UserProfileService';
import type { TribeMember } from '../../../services/storage/TribeFileStorage';
import type { UserProfile } from '../../../services/UserProfileService';

interface MemberWithProfile extends TribeMember {
  profile?: UserProfile;
  isPrivate: boolean;
}

export class TribeSecondaryManager {
  private containerElement: HTMLElement;
  private eventBus: EventBus;
  private authService: AuthService;
  private modalService: ModalService;
  private tribeOrch: TribeOrchestrator;
  private folderService: TribeFolderService;
  private listSyncManager: ListSyncManager<TribeMember>;
  private adapter: TribeStorageAdapter;
  private profileService: UserProfileService;

  // View state
  private currentFolderId: string = ''; // '' = root
  private membersCache: Map<string, MemberWithProfile> = new Map();
  private isLoading: boolean = false;

  // Event handler for cleanup
  private closeDropdownHandler: ((e: Event) => void) | null = null;

  constructor(containerElement: HTMLElement) {
    this.containerElement = containerElement;
    this.eventBus = EventBus.getInstance();
    this.authService = AuthService.getInstance();
    this.modalService = ModalService.getInstance();
    this.tribeOrch = TribeOrchestrator.getInstance();
    this.folderService = TribeFolderService.getInstance();
    this.profileService = UserProfileService.getInstance();

    this.adapter = new TribeStorageAdapter();
    this.listSyncManager = new ListSyncManager(this.adapter);

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    this.eventBus.on('tribe:updated', () => {
      this.refreshIfActive();
    });

    this.eventBus.on('user:logout', () => {
      this.currentFolderId = '';
      this.membersCache.clear();
    });

    // On user switch, clear cache and refresh if active
    this.eventBus.on('user:login', () => {
      this.currentFolderId = '';
      this.membersCache.clear();
      this.refreshIfActive();
    });

    // Re-render when sync mode changes (Manual <-> Easy)
    this.eventBus.on('list-sync-mode:changed', () => {
      this.refreshIfActive();
    });
  }

  private refreshIfActive(): void {
    const listTab = this.containerElement.querySelector('[data-tab-content="list-tribes"]');
    if (listTab && listTab.classList.contains('tab-content--active')) {
      this.renderTribesTab(listTab as HTMLElement);
    }
  }

  /**
   * Handle tab switch (called by MainLayout)
   */
  public handleTabSwitch(tabName: string, content: HTMLElement): void {
    if (tabName === 'tribes') {
      this.renderTribesTab(content);
    }
  }

  /**
   * Public render method (called by MainLayout)
   */
  public async renderListTab(container: HTMLElement): Promise<void> {
    await this.renderTribesTab(container);
  }

  /**
   * Main render function
   */
  private async renderTribesTab(container: HTMLElement): Promise<void> {
    const currentUser = this.authService.getCurrentUser();

    if (!currentUser) {
      container.innerHTML = `
        <div class="tribes-empty-state">
          <p>Log in to see your tribes</p>
        </div>
      `;
      return;
    }

    // Show loading
    container.innerHTML = `
      <div class="tribes-loading">Loading tribes...</div>
    `;

    try {
      // Fetch all members from browser storage
      await this.loadMembers();

      // Render the view
      await this.renderCurrentView(container);
    } catch (error) {
      console.error('Failed to render tribes:', error);
      container.innerHTML = `
        <div class="tribes-empty-state">
          <p>Failed to load tribes</p>
        </div>
      `;
    }
  }

  /**
   * Load all tribe members and their profiles
   */
  private async loadMembers(): Promise<void> {
    if (this.isLoading) return;
    this.isLoading = true;

    try {
      // Use RestoreListsService for cascading restore (browser → file → relays)
      const restoreService = RestoreListsService.getInstance();
      const result = await restoreService.restoreIfEmpty(
        this.listSyncManager,
        () => this.adapter.getBrowserItems(),
        (items) => this.adapter.setBrowserItems(items),
        'Tribes',
        async () => {
          // Restore folder data is not yet implemented for tribes
        },
        async (syncResult) => {
          // After relay sync: create folders from categories and assign members
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
                console.log(`[TribeSecondaryManager] Created tribe from relay: "${categoryName}"`);
              }
            }

            // Assign members to their categories from relay
            const updatedFolders = this.folderService.getFolders();
            for (const [memberPubkey, categoryName] of syncResult.categoryAssignments) {
              if (categoryName === '') {
                // Root - ensure assignment exists
                this.folderService.ensureMemberAssignment(memberPubkey);
              } else {
                // Find folder by name and move member there
                const folder = updatedFolders.find(f => f.name === categoryName);
                if (folder) {
                  this.folderService.moveMemberToFolder(memberPubkey, folder.id);
                }
              }
            }

            console.log(`[TribeSecondaryManager] Restored ${categoriesWithItems.size} tribes from relays`);
          }
        }
      );

      if (result.source === 'empty') {
        this.membersCache.clear();
        return;
      }

      const membersFromBrowser = this.adapter.getBrowserItems();
      if (membersFromBrowser.length === 0) {
        this.membersCache.clear();
        return;
      }

      // Sort members by addedAt DESC (newest first) for initial display
      const sortedMembers = [...membersFromBrowser].sort((a, b) => {
        const timeA = a.addedAt || 0;
        const timeB = b.addedAt || 0;
        return timeB - timeA; // DESC - newest first
      });

      // Fetch profiles for all members
      const profiles = await Promise.all(
        sortedMembers.map(m => this.profileService.getUserProfile(m.pubkey))
      );

      this.membersCache.clear();

      // Check if this is first initialization (no root order yet)
      const isFirstInit = !this.folderService.hasRootOrder();

      // Process in sorted order (newest first)
      for (let i = 0; i < sortedMembers.length; i++) {
        const member = sortedMembers[i];
        const profile = profiles[i];
        this.membersCache.set(member.pubkey, {
          ...member,
          profile: profile || undefined,
          isPrivate: (member as TribeMember & { isPrivate?: boolean }).isPrivate || false
        });

        // Ensure folder assignment exists
        this.folderService.ensureMemberAssignment(member.pubkey);
      }

      // On first init, build root order from sorted members (newest first)
      if (isFirstInit) {
        const rootOrder: Array<{ type: 'folder' | 'member'; id: string }> = [];
        for (const member of sortedMembers) {
          rootOrder.push({ type: 'member', id: member.pubkey });
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
      <div class="tribe-grid"></div>
      ${this.renderSyncControls()}
    `;

    // Bind sync buttons
    this.bindSyncButtons(container);

    // Bind header buttons
    this.bindHeaderButtons(container);

    // Render grid content
    const grid = container.querySelector('.tribe-grid') as HTMLElement;
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
    const title = folder ? folder.name : 'Tribes';

    return `
      <div class="bookmark-header">
        <span class="bookmark-header__title">${this.escapeHtml(title)}</span>
        <div class="bookmark-header__new-dropdown">
            <button class="bookmark-header__new-btn" title="Create new">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 5V19M5 12H19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
              New
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" class="bookmark-header__new-chevron">
                <path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </button>
            <div class="bookmark-header__dropdown-menu">
              <button class="bookmark-header__dropdown-item" data-action="new-tribe">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path d="M3 7C3 5.89543 3.89543 5 5 5H9.58579C9.851 5 10.1054 5.10536 10.2929 5.29289L12 7H19C20.1046 7 21 7.89543 21 9V17C21 18.1046 20.1046 19 19 19H5C3.89543 19 3 18.1046 3 17V7Z" stroke="currentColor" stroke-width="1.5"/>
                </svg>
                Tribe
              </button>
              <button class="bookmark-header__dropdown-item" data-action="new-member">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                Member
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
        <span class="bookmark-breadcrumb__item" data-navigate="root">Tribes</span>
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
        onDrop: async (memberPubkey) => {
          await this.moveMemberToFolder(memberPubkey, '');
        }
      });
      grid.appendChild(upNav.render());

      // Get members in this folder
      const memberIds = this.folderService.getMembersInFolder(this.currentFolderId);
      for (const memberPubkey of memberIds) {
        const member = this.membersCache.get(memberPubkey);
        if (member) {
          const card = await this.createMemberCard(member);
          grid.appendChild(card);
        }
      }
    } else {
      // Root view - mixed folders and members
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
        } else if (item.type === 'member') {
          const member = this.membersCache.get(item.id);
          // Only show if in root (no folder assignment)
          const folderId = this.folderService.getMemberFolder(item.id);
          if (member && folderId === '') {
            const card = await this.createMemberCard(member);
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

      for (const [memberPubkey, member] of this.membersCache) {
        const folderId = this.folderService.getMemberFolder(memberPubkey);
        if (folderId === '' && !renderedIds.has(memberPubkey)) {
          const card = await this.createMemberCard(member);
          grid.appendChild(card);
          this.folderService.addToRootOrder('member', memberPubkey);
        }
      }
    }

    // Check empty state
    if (grid.children.length === 0 || (this.currentFolderId === '' && grid.children.length === 0)) {
      grid.innerHTML = `
        <div class="tribes-empty-state" style="grid-column: 1 / -1;">
          <p>No tribe members yet</p>
        </div>
      `;
    }

    // Setup drag & drop for reordering
    this.setupGridDragDrop(grid);
  }

  /**
   * Create a member card
   */
  private async createMemberCard(member: MemberWithProfile): Promise<HTMLElement> {
    const card = new TribeMemberCard({
      pubkey: member.pubkey,
      isPrivate: member.isPrivate,
      folderId: this.folderService.getMemberFolder(member.pubkey)
    }, {
      onDelete: async (pubkey: string) => {
        await this.deleteMember(pubkey);
      }
    });

    return await card.render();
  }

  /**
   * Create a folder card
   */
  private createFolderCard(folder: { id: string; name: string }): HTMLElement {
    const folderData: FolderData = {
      id: folder.id,
      name: folder.name,
      itemCount: this.folderService.getFolderItemCount(folder.id),
      isMounted: false // Tribes don't support profile mounting
    };

    const card = new FolderCard(folderData, {
      onClick: (folderId) => this.navigateToFolder(folderId),
      onEdit: (folderId) => this.editFolder(folderId),
      onDelete: async (folderId) => {
        await this.deleteFolder(folderId);
      },
      onDrop: async (memberPubkey, folderId) => {
        await this.moveMemberToFolder(memberPubkey, folderId);
      },
      onDragStart: (_folderId) => {
        // Drag state tracked internally by setupGridDragDrop
      },
      onDragEnd: () => {
        // Drag state tracked internally by setupGridDragDrop
      },
      showMountCheckbox: false // Tribes don't support profile mounting
    });

    return card.render();
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
      if (target.closest('.tribe-member-card__delete') || target.closest('.folder-card__delete')) {
        return;
      }

      const card = target.closest('.tribe-member-card, .folder-card') as HTMLElement;
      if (!card || card.classList.contains('up-navigator')) return;

      e.preventDefault();
      draggedCard = card;
      draggedId = card.dataset.pubkey || card.dataset.folderId || null;
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
        placeholder.className = 'tribe-member-card-placeholder';
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
        const cardBelow = elemBelow?.closest('.tribe-member-card:not(.dragging), .folder-card:not(.dragging), .up-navigator') as HTMLElement;

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
      const savedDisplay = draggedCard.style.display;
      draggedCard.style.display = 'none';
      const elemBelow = document.elementFromPoint(e.clientX, e.clientY);
      draggedCard.style.display = savedDisplay;
      const dropTarget = elemBelow?.closest('.tribe-member-card, .folder-card, .up-navigator') as HTMLElement;

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
        const targetId = dropTarget.dataset.pubkey || dropTarget.dataset.folderId;
        const isDraggingMember = draggedCard.classList.contains('tribe-member-card');
        const isDraggingFolder = draggedCard.classList.contains('folder-card');
        const isTargetFolder = dropTarget.classList.contains('folder-card');
        const isTargetUpNav = dropTarget.classList.contains('up-navigator');

        if (isTargetUpNav && isDraggingMember) {
          // Move member to root (from folder)
          this.moveMemberToFolder(draggedId, '');
        } else if (isTargetFolder && isDraggingMember && targetId) {
          // Move member into folder
          this.moveMemberToFolder(draggedId, targetId);
        } else if (targetId && targetId !== draggedId) {
          // Reorder
          if (this.currentFolderId && isDraggingMember) {
            // Inside a folder - reorder members within folder
            const membersInFolder = this.folderService.getMembersInFolder(this.currentFolderId);
            const targetIndex = membersInFolder.findIndex(id => id === targetId);
            if (targetIndex !== -1) {
              this.folderService.moveItemToPosition(draggedId, targetIndex);
              grid.insertBefore(draggedCard, dropTarget);
            }
          } else {
            // Root level - use root order
            const draggedType = isDraggingFolder ? 'folder' : 'member';
            const rootOrder = this.folderService.getRootOrder();
            const targetIndex = rootOrder.findIndex(item => item.id === targetId);
            if (targetIndex !== -1) {
              this.folderService.moveInRootOrder(draggedType as 'folder' | 'member', draggedId, targetIndex);
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

  private navigateToFolder(folderId: string): void {
    this.currentFolderId = folderId;
    const container = this.containerElement.querySelector('[data-tab-content="list-tribes"]');
    if (container) {
      this.renderCurrentView(container as HTMLElement);
    }
  }

  private navigateToRoot(): void {
    this.currentFolderId = '';
    const container = this.containerElement.querySelector('[data-tab-content="list-tribes"]');
    if (container) {
      this.renderCurrentView(container as HTMLElement);
    }
  }

  /**
   * Delete member from tribe
   */
  private async deleteMember(pubkey: string): Promise<void> {
    try {
      await this.tribeOrch.removeMember(pubkey);

      // Remove from cache
      this.membersCache.delete(pubkey);

      // Remove from folder service
      this.folderService.removeMemberAssignment(pubkey);

      ToastService.show('Member removed', 'success');

      // Re-render
      const container = this.containerElement.querySelector('[data-tab-content="list-tribes"]');
      if (container) {
        this.renderCurrentView(container as HTMLElement);
      }
    } catch (error) {
      console.error('Failed to delete member:', error);
      ToastService.show('Failed to remove member', 'error');
    }
  }

  /**
   * Edit folder (rename)
   */
  private editFolder(folderId: string): void {
    const folder = this.folderService.getFolder(folderId);
    if (!folder) return;

    const modal = new EditFolderModal({
      folderId: folder.id,
      currentName: folder.name,
      onSave: (newName: string) => {
        this.folderService.renameFolder(folderId, newName);
        ToastService.show('Tribe renamed', 'success');

        // Re-render
        const container = this.containerElement.querySelector('[data-tab-content="list-tribes"]');
        if (container) {
          this.renderCurrentView(container as HTMLElement);
        }
      }
    });

    modal.show();
  }

  /**
   * Delete folder
   */
  private async deleteFolder(folderId: string): Promise<void> {
    const folder = this.folderService.getFolder(folderId);
    if (!folder) return;

    const itemCount = this.folderService.getFolderItemCount(folderId);
    const message = itemCount > 0
      ? `Delete tribe "${folder.name}"? ${itemCount} member(s) will be moved to root.`
      : `Delete tribe "${folder.name}"?`;

    // Show confirmation modal
    this.modalService.show({
      title: 'Delete Tribe',
      content: `
        <div style="padding: 1rem 0;">
          <p>${message}</p>
        </div>
        <div style="display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1.5rem;">
          <button class="btn" data-action="cancel">Cancel</button>
          <button class="btn btn--danger" data-action="confirm">Delete</button>
        </div>
      `,
      width: '400px',
      showCloseButton: true,
      closeOnOverlay: true,
      closeOnEsc: true
    });

    // Setup modal button handlers
    setTimeout(() => {
      const cancelBtn = document.querySelector('[data-action="cancel"]');
      const confirmBtn = document.querySelector('[data-action="confirm"]');

      cancelBtn?.addEventListener('click', () => {
        this.modalService.hide();
      });

      confirmBtn?.addEventListener('click', async () => {
        try {
          // Delete folder (members are moved to root automatically)
          this.folderService.deleteFolder(folderId);

          ToastService.show('Tribe deleted', 'success');

          // Navigate to root if we're in the deleted folder
          if (this.currentFolderId === folderId) {
            this.currentFolderId = '';
          }

          this.modalService.hide();

          // Re-render
          const container = this.containerElement.querySelector('[data-tab-content="list-tribes"]');
          if (container) {
            this.renderCurrentView(container as HTMLElement);
          }
        } catch (error) {
          console.error('Failed to delete tribe:', error);
          ToastService.show('Failed to delete tribe', 'error');
          this.modalService.hide();
        }
      });
    }, 0);
  }

  /**
   * Move member to a different folder
   */
  private async moveMemberToFolder(memberPubkey: string, targetFolderId: string): Promise<void> {
    try {
      this.folderService.moveMemberToFolder(memberPubkey, targetFolderId);

      const targetName = targetFolderId === ''
        ? 'root'
        : this.folderService.getFolder(targetFolderId)?.name || 'tribe';

      ToastService.show(`Moved to ${targetName}`, 'success');

      // Re-render
      const container = this.containerElement.querySelector('[data-tab-content="list-tribes"]');
      if (container) {
        this.renderCurrentView(container as HTMLElement);
      }
    } catch (error) {
      console.error('Failed to move member:', error);
      ToastService.show('Failed to move member', 'error');
    }
  }

  /**
   * Create new tribe (folder)
   */
  private createNewTribe(): void {
    const modal = new NewFolderModal({
      onConfirm: (name: string) => {
        const folder = this.folderService.createFolder(name);
        ToastService.show('Tribe created', 'success');

        // Re-render (stay in root)
        const container = this.containerElement.querySelector('[data-tab-content="list-tribes"]');
        if (container) {
          this.renderCurrentView(container as HTMLElement);
        }
      }
    });

    modal.show();
  }

  /**
   * Add new member(s) to tribe
   */
  private addNewMember(): void {
    const tribes = this.folderService.getFolders();
    const tribeOptions = tribes.map(t =>
      `<option value="${t.id}">${this.escapeHtml(t.name)}</option>`
    ).join('');

    const container = document.createElement('div');
    container.className = 'new-bookmark-modal';

    container.innerHTML = `
      <div class="new-bookmark-modal__content">
        <div class="form-group">
          <label for="tribe-member-input">Members (@username, comma-separated)</label>
          <textarea
            id="tribe-member-input"
            class="input"
            placeholder="@alice, @bob, @charlie..."
            rows="3"
            autocomplete="off"
          ></textarea>
          <p style="margin-top: 0.5rem; font-size: 0.875rem; color: var(--color-text-secondary);">Type @ to search your follows</p>
        </div>

        <div class="form-group">
          <label for="tribe-select">Tribe</label>
          <select id="tribe-select" class="input">
            ${tribes.length === 0 ? '<option value="">No tribes available</option>' : tribeOptions}
          </select>
        </div>

        <div class="new-bookmark-modal__actions">
          <button type="button" class="btn btn--passive" id="tribe-member-cancel-btn">
            Cancel
          </button>
          <button type="button" class="btn" id="tribe-member-save-btn" ${tribes.length === 0 ? 'disabled' : ''}>
            Add Members
          </button>
        </div>
      </div>
    `;

    this.modalService.show({
      title: 'Add Members to Tribe',
      content: container,
      width: '450px',
      showCloseButton: true,
      closeOnOverlay: true,
      closeOnEsc: true
    });

    // Setup modal handlers
    setTimeout(async () => {
      const input = document.getElementById('tribe-member-input') as HTMLTextAreaElement;
      const tribeSelect = document.getElementById('tribe-select') as HTMLSelectElement;
      const cancelBtn = document.getElementById('tribe-member-cancel-btn');
      const saveBtn = document.getElementById('tribe-member-save-btn');

      input?.focus();

      // Initialize mention autocomplete
      const { MentionAutocomplete } = await import('../../mentions/MentionAutocomplete');
      const mentionAutocomplete = new MentionAutocomplete({
        textareaSelector: '#tribe-member-input'
      });
      mentionAutocomplete.init();

      const handleSave = async () => {
        const selectedTribeId = tribeSelect?.value;
        const inputValue = input?.value.trim();

        if (!selectedTribeId || !inputValue) {
          ToastService.show('Please enter members and select a tribe', 'error');
          return;
        }

        await this.processAddMembers(inputValue, selectedTribeId);
        this.modalService.hide();
      };

      cancelBtn?.addEventListener('click', () => {
        this.modalService.hide();
      });

      saveBtn?.addEventListener('click', handleSave);

      // Enter key on textarea
      input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.ctrlKey) {
          handleSave();
        } else if (e.key === 'Escape') {
          this.modalService.hide();
        }
      });
    }, 0);
  }

  /**
   * Process adding members from comma-separated @mentions or npubs
   */
  private async processAddMembers(inputValue: string, tribeId: string): Promise<void> {
    try {
      // Extract all pubkeys from text (supports @mentions as nostr:npub..., direct npubs, and nprofiles)
      const { extractPubkeysFromText } = await import('../../../helpers/nip19');
      const pubkeys = extractPubkeysFromText(inputValue);

      if (pubkeys.length === 0) {
        ToastService.show('No valid npubs or mentions found.', 'error');
        return;
      }

      const isPrivate = this.tribeOrch.isPrivateTribesEnabled();

      let added = 0;
      const addedPubkeys: string[] = [];
      for (const pubkey of pubkeys) {
        try {
          await this.tribeOrch.addMember(pubkey, isPrivate, tribeId);
          addedPubkeys.push(pubkey);
          added++;
        } catch (error) {
          console.error(`Failed to add member ${pubkey}:`, error);
        }
      }

      if (added > 0) {
        // Load profiles for newly added members and update cache
        for (const pubkey of addedPubkeys) {
          const profile = await this.profileService.getUserProfile(pubkey);
          const browserItem = this.adapter.getBrowserItems().find(m => m.pubkey === pubkey);
          if (browserItem) {
            this.membersCache.set(pubkey, {
              ...browserItem,
              profile: profile || undefined,
              isPrivate: this.tribeOrch.isPrivateTribesEnabled()
                ? (browserItem.isPrivate || false)
                : false
            });
          }
        }

        ToastService.show(`Added ${added} member(s)`, 'success');

        // Re-render if we're in the target tribe or root
        if (this.currentFolderId === tribeId || this.currentFolderId === '') {
          const container = this.containerElement.querySelector('[data-tab-content="list-tribes"]');
          if (container) {
            this.renderCurrentView(container as HTMLElement);
          }
        }
      } else {
        ToastService.show('No members added', 'error');
      }
    } catch (error) {
      console.error('Failed to add members:', error);
      ToastService.show('Failed to add members', 'error');
    }
  }

  /**
   * Bind sync buttons
   */
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

  /**
   * Bind header buttons (New dropdown)
   */
  private bindHeaderButtons(container: HTMLElement): void {
    const newBtn = container.querySelector('.bookmark-header__new-btn');
    const dropdown = container.querySelector('.bookmark-header__new-dropdown');
    const newTribeBtn = container.querySelector('[data-action="new-tribe"]');
    const newMemberBtn = container.querySelector('[data-action="new-member"]');

    // Breadcrumb navigation
    const rootNav = container.querySelector('[data-navigate="root"]');
    rootNav?.addEventListener('click', () => this.navigateToRoot());

    if (!newBtn || !dropdown) return;

    // Toggle dropdown
    newBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('bookmark-header__new-dropdown--open');
    });

    // Create new tribe
    newTribeBtn?.addEventListener('click', () => {
      dropdown.classList.remove('bookmark-header__new-dropdown--open');
      this.createNewTribe();
    });

    // Add new member
    newMemberBtn?.addEventListener('click', () => {
      dropdown.classList.remove('bookmark-header__new-dropdown--open');
      this.addNewMember();
    });

    // Close dropdown when clicking outside
    if (this.closeDropdownHandler) {
      document.removeEventListener('click', this.closeDropdownHandler);
    }
    this.closeDropdownHandler = (e: Event) => {
      if (!dropdown.contains(e.target as Node)) {
        dropdown.classList.remove('bookmark-header__new-dropdown--open');
      }
    };
    document.addEventListener('click', this.closeDropdownHandler);
  }

  /**
   * Sync from relays (Manual mode)
   */
  private async handleSyncFromRelays(container: HTMLElement): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      ToastService.show('Please log in first', 'error');
      return;
    }

    try {
      ToastService.show('Syncing from relays...', 'info');

      const result = await this.listSyncManager.syncFromRelays(currentUser.pubkey);
      const added = result.added || 0;

      ToastService.show(`Synced from relays: ${added} new members`, 'success');

      // Reload and re-render
      this.membersCache.clear();
      await this.loadMembers();
      await this.renderCurrentView(container);
    } catch (error) {
      console.error('Sync from relays failed:', error);
      ToastService.show('Failed to sync from relays', 'error');
    }
  }

  /**
   * Sync to relays (Manual mode)
   */
  private async handleSyncToRelays(): Promise<void> {
    try {
      ToastService.show('Publishing to relays...', 'info');
      await this.listSyncManager.syncToRelays();
      ToastService.show('Published to relays', 'success');
    } catch (error) {
      console.error('Publish to relays failed:', error);
      ToastService.show('Failed to publish to relays', 'error');
    }
  }

  /**
   * Save to file (Manual mode)
   */
  private async handleSaveToFile(): Promise<void> {
    try {
      ToastService.show('Saving to file...', 'info');
      await this.listSyncManager.saveToFile();
      ToastService.show('Saved to file', 'success');
    } catch (error) {
      console.error('Save to file failed:', error);
      ToastService.show('Failed to save to file', 'error');
    }
  }

  /**
   * Restore from file (Manual mode)
   */
  private async handleRestoreFromFile(container: HTMLElement): Promise<void> {
    try {
      ToastService.show('Restoring from file...', 'info');

      const browserItems = this.adapter.getBrowserItems();
      const fileMembers = await this.adapter.getFileItems();
      const hasExisting = browserItems.length > 0;

      if (hasExisting) {
        // Calculate diff
        const browserPubkeys = new Set(browserItems.map(m => m.pubkey));
        const filePubkeys = new Set(fileMembers.map(m => m.pubkey));

        const added = fileMembers.filter(m => !browserPubkeys.has(m.pubkey));
        const removed = browserItems.filter(m => !filePubkeys.has(m.pubkey));

        const modal = new SyncConfirmationModal({
          listType: 'Tribes',
          added: added,
          removed: removed,
          getDisplayName: async (item) => {
            const profile = await this.profileService.getUserProfile(item.pubkey);
            return profile?.name || item.pubkey.slice(0, 8) + '...';
          },
          onKeep: async () => {
            // Merge: Add new items from file, keep existing
            await this.restoreFoldersAndMembers();
            ToastService.show('Merged tribes from file', 'success');

            // Reload and re-render
            this.membersCache.clear();
            await this.loadMembers();
            await this.renderCurrentView(container);
          },
          onDelete: async () => {
            // Overwrite: Replace with file content
            await this.restoreFoldersAndMembers();
            ToastService.show('Restored from file', 'success');

            // Reload and re-render
            this.membersCache.clear();
            await this.loadMembers();
            await this.renderCurrentView(container);
          }
        });

        modal.show();
      } else {
        // No browser items - restore directly
        await this.restoreFoldersAndMembers();
        ToastService.show('Restored from file', 'success');

        // Reload and re-render
        this.membersCache.clear();
        await this.loadMembers();
        await this.renderCurrentView(container);
      }
    } catch (error) {
      console.error('Restore from file failed:', error);
      ToastService.show('Failed to restore from file', 'error');
    }
  }

  /**
   * Restore folders and members from file (creates folder structure from categories)
   */
  private async restoreFoldersAndMembers(): Promise<void> {
    // Restore tribe members from file
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

    // Assign members to their categories
    const updatedFolders = this.folderService.getFolders();
    for (const item of restoredItems) {
      const categoryName = item.category || '';
      if (categoryName === '') {
        // Root - ensure assignment exists
        this.folderService.ensureMemberAssignment(item.pubkey);
      } else {
        // Find folder by name and move member there
        const folder = updatedFolders.find(f => f.name === categoryName);
        if (folder) {
          this.folderService.ensureMemberAssignment(item.pubkey);
          this.folderService.moveMemberToFolder(item.pubkey, folder.id);
        } else {
          // Folder not found - assign to root
          this.folderService.ensureMemberAssignment(item.pubkey);
        }
      }
    }
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    if (this.closeDropdownHandler) {
      document.removeEventListener('click', this.closeDropdownHandler);
      this.closeDropdownHandler = null;
    }
  }
}
