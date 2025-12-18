/**
 * ProfileListsComponent
 * Displays bookmark folders mounted to a user's profile
 *
 * Features:
 * - Fetch and display mounted bookmark folders
 * - 5 items per folder initially, "Show more" for expansion
 * - Drag handles for reordering (own profile only)
 * - Works for both own and other users' profiles
 *
 * @purpose Display NIP-78 profile-mounted bookmark lists
 * @used-by ProfileView
 */

import { ProfileMountsService } from '../../services/ProfileMountsService';
import { ProfileMountsOrchestrator } from '../../services/orchestration/ProfileMountsOrchestrator';
import { BookmarkOrchestrator } from '../../services/orchestration/BookmarkOrchestrator';
import { BookmarkFolderService } from '../../services/BookmarkFolderService';
import { AuthService } from '../../services/AuthService';
import type { BookmarkItem } from '../../services/storage/BookmarkFileStorage';

const MAX_ITEMS_COLLAPSED = 5;

interface ProfileListData {
  folderName: string;
  items: BookmarkItem[];
  isExpanded: boolean;
}

export class ProfileListsComponent {
  private container: HTMLElement;
  private pubkey: string;
  private isOwnProfile: boolean;
  private profileMountsService: ProfileMountsService;
  private profileMountsOrch: ProfileMountsOrchestrator;
  private bookmarkOrch: BookmarkOrchestrator;
  private folderService: BookmarkFolderService;
  private authService: AuthService;

  private lists: ProfileListData[] = [];

  constructor(pubkey: string) {
    this.pubkey = pubkey;
    this.container = document.createElement('div');
    // Note: 'profile-lists' class added in render() only if folders exist

    this.profileMountsService = ProfileMountsService.getInstance();
    this.profileMountsOrch = ProfileMountsOrchestrator.getInstance();
    this.bookmarkOrch = BookmarkOrchestrator.getInstance();
    this.folderService = BookmarkFolderService.getInstance();
    this.authService = AuthService.getInstance();

    // Check if viewing own profile
    const currentUser = this.authService.getCurrentUser();
    this.isOwnProfile = currentUser?.pubkey === pubkey;
  }

  /**
   * Load and render profile lists
   */
  public async render(): Promise<HTMLElement> {
    this.container.innerHTML = '<div class="profile-lists__loading">Loading lists...</div>';

    try {
      // Get mounted folder names
      let mountedFolders: string[];

      if (this.isOwnProfile) {
        // Own profile: read from localStorage
        mountedFolders = this.profileMountsService.getMounts();
      } else {
        // Other profile: fetch from relays
        mountedFolders = await this.profileMountsOrch.fetchFromRelays(this.pubkey, true);
      }

      if (mountedFolders.length === 0) {
        this.container.innerHTML = '';
        this.container.className = '';
        return this.container;
      }

      // Add class now that we know folders exist
      this.container.className = 'profile-lists';

      // Fetch bookmark items for each folder
      await this.loadListItems(mountedFolders);

      // Render lists
      this.renderLists();
    } catch (error) {
      console.error('Failed to load profile lists:', error);
      this.container.innerHTML = '';
      this.container.className = '';
    }

    return this.container;
  }

  /**
   * Load bookmark items for each mounted folder
   */
  private async loadListItems(folderNames: string[]): Promise<void> {
    this.lists = [];

    if (this.isOwnProfile) {
      // Own profile: read from localStorage with correct folder order
      const allItems = this.bookmarkOrch.getBrowserItems();
      const folders = this.folderService.getFolders();

      for (const folderName of folderNames) {
        // Find folder by name to get its ID
        const folder = folders.find(f => f.name === folderName);

        if (folder) {
          // Get ordered bookmark IDs from folder service
          const orderedIds = this.folderService.getBookmarksInFolder(folder.id);

          // Map to actual items, maintaining order
          const folderItems = orderedIds
            .map(id => allItems.find(item => item.id === id))
            .filter((item): item is BookmarkItem => item !== undefined && !item.isPrivate);

          if (folderItems.length > 0) {
            this.lists.push({
              folderName,
              items: folderItems,
              isExpanded: false
            });
          }
        }
      }
    } else {
      // Other profile: fetch bookmarks from relays
      try {
        const fetchResult = await this.bookmarkOrch.fetchBookmarksFromRelays(this.pubkey);

        for (const folderName of folderNames) {
          // Find items in this category
          const folderItems = fetchResult.items.filter(item => {
            const itemCategory = fetchResult.categoryAssignments?.get(item.id) || '';
            return itemCategory === folderName && !item.isPrivate;
          });

          if (folderItems.length > 0) {
            this.lists.push({
              folderName,
              items: folderItems,
              isExpanded: false
            });
          }
        }
      } catch (error) {
        console.error('Failed to fetch bookmarks from relays:', error);
      }
    }
  }

  /**
   * Render all lists
   */
  private renderLists(): void {
    if (this.lists.length === 0) {
      this.container.innerHTML = '';
      return;
    }

    this.container.innerHTML = this.lists.map((list, index) =>
      this.renderList(list, index)
    ).join('');

    this.bindEvents();
  }

  /**
   * Render a single list
   */
  private renderList(list: ProfileListData, index: number): string {
    const { folderName, items, isExpanded } = list;
    const visibleItems = isExpanded ? items : items.slice(0, MAX_ITEMS_COLLAPSED);
    const hasMore = items.length > MAX_ITEMS_COLLAPSED;

    return `
      <div class="profile-list-section" data-list-index="${index}">
        <div class="profile-list-header">
          <h3 class="profile-list-title">${this.escapeHtml(folderName)}</h3>
          ${this.isOwnProfile ? `
            <button class="profile-list-drag-handle" title="Drag to reorder">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                <circle cx="3" cy="2" r="1.5"/>
                <circle cx="9" cy="2" r="1.5"/>
                <circle cx="3" cy="6" r="1.5"/>
                <circle cx="9" cy="6" r="1.5"/>
                <circle cx="3" cy="10" r="1.5"/>
                <circle cx="9" cy="10" r="1.5"/>
              </svg>
            </button>
          ` : ''}
        </div>
        <div class="profile-list-items">
          ${visibleItems.map(item => this.renderItem(item)).join('')}
        </div>
        ${hasMore ? `
          <button class="profile-list-toggle" data-list-index="${index}">
            ${isExpanded ? 'Show less' : `Show more (${items.length - MAX_ITEMS_COLLAPSED})`}
          </button>
        ` : ''}
      </div>
    `;
  }

  /**
   * Render a single item
   */
  private renderItem(item: BookmarkItem): string {
    if (item.type === 'r') {
      // URL bookmark
      const url = item.value || item.id;
      const description = item.description || '';

      let displayUrl = url;
      try {
        const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
        displayUrl = parsed.hostname + (parsed.pathname !== '/' ? parsed.pathname : '');
      } catch {
        // Keep original
      }

      return `
        <div class="profile-list-item profile-list-item--url">
          <span class="profile-list-item__icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
            </svg>
          </span>
          <div class="profile-list-item__content">
            <a href="${url.startsWith('http') ? url : `https://${url}`}" rel="noopener noreferrer" class="profile-list-item__url">
              ${this.escapeHtml(displayUrl)}
            </a>
            ${description ? `<span class="profile-list-item__desc">${this.escapeHtml(description)}</span>` : ''}
          </div>
        </div>
      `;
    } else if (item.type === 'e') {
      // Event reference - show truncated ID
      return `
        <div class="profile-list-item profile-list-item--note">
          <span class="profile-list-item__icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </span>
          <div class="profile-list-item__content">
            <span class="profile-list-item__id">${item.id.slice(0, 16)}...</span>
          </div>
        </div>
      `;
    } else {
      // Other types
      return `
        <div class="profile-list-item">
          <span class="profile-list-item__icon">•</span>
          <div class="profile-list-item__content">
            <span>${this.escapeHtml(item.value || item.id)}</span>
          </div>
        </div>
      `;
    }
  }

  /**
   * Bind event listeners
   */
  private bindEvents(): void {
    // Toggle show more/less
    this.container.querySelectorAll('.profile-list-toggle').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt((e.target as HTMLElement).dataset.listIndex || '0');
        this.toggleListExpansion(index);
      });
    });

    // Drag & drop for reordering (own profile only)
    if (this.isOwnProfile) {
      this.setupDragDrop();
    }
  }

  /**
   * Toggle list expansion
   */
  private toggleListExpansion(index: number): void {
    if (this.lists[index]) {
      this.lists[index].isExpanded = !this.lists[index].isExpanded;
      this.renderLists();
    }
  }

  /**
   * Setup drag & drop for reordering
   */
  private setupDragDrop(): void {
    const sections = this.container.querySelectorAll('.profile-list-section');
    let draggedSection: HTMLElement | null = null;
    let startY = 0;
    let startIndex = 0;

    sections.forEach((section) => {
      const handle = section.querySelector('.profile-list-drag-handle');
      if (!handle) return;

      handle.addEventListener('mousedown', (_e: Event) => {
        const mouseEvent = _e as MouseEvent;
        mouseEvent.preventDefault();
        draggedSection = section as HTMLElement;
        startY = mouseEvent.clientY;
        startIndex = parseInt(draggedSection.dataset.listIndex || '0');

        draggedSection.classList.add('dragging');
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });
    });

    const onMouseMove = (e: MouseEvent) => {
      if (!draggedSection) return;

      const deltaY = e.clientY - startY;
      draggedSection.style.transform = `translateY(${deltaY}px)`;

      // Find drop target
      sections.forEach((section, _index) => {
        if (section === draggedSection) return;
        const rect = section.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;

        if (e.clientY < midY && e.clientY > rect.top) {
          section.classList.add('drop-above');
        } else if (e.clientY > midY && e.clientY < rect.bottom) {
          section.classList.add('drop-below');
        } else {
          section.classList.remove('drop-above', 'drop-below');
        }
      });
    };

    const onMouseUp = (_e: MouseEvent) => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      if (!draggedSection) return;

      // Find new position
      let newIndex = startIndex;
      sections.forEach((section, index) => {
        if (section.classList.contains('drop-above')) {
          newIndex = index;
        } else if (section.classList.contains('drop-below')) {
          newIndex = index + 1;
        }
        section.classList.remove('drop-above', 'drop-below');
      });

      draggedSection.classList.remove('dragging');
      draggedSection.style.transform = '';

      // Reorder if position changed
      if (newIndex !== startIndex) {
        this.reorderList(startIndex, newIndex);
      }

      draggedSection = null;
    };
  }

  /**
   * Reorder list and save
   */
  private reorderList(fromIndex: number, toIndex: number): void {
    // Reorder in local array
    const [moved] = this.lists.splice(fromIndex, 1);
    this.lists.splice(toIndex > fromIndex ? toIndex - 1 : toIndex, 0, moved);

    // Update service
    const newOrder = this.lists.map(l => l.folderName);
    this.profileMountsService.reorderMounts(newOrder);

    // Publish to relays (async)
    this.profileMountsOrch.publishToRelays().catch(err => {
      console.error('Failed to publish reordered mounts:', err);
    });

    // Re-render
    this.renderLists();
  }

  /**
   * Escape HTML
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Get container element
   */
  public getElement(): HTMLElement {
    return this.container;
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    this.container.remove();
  }
}
