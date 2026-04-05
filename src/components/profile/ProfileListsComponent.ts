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
import {
  BookmarkOrchestrator,
  getBookmarkFolderService,
  type BookmarkItem
} from '../../lists/bookmarks';
import { AuthService } from '../../services/AuthService';
import { escapeHtml } from '../../helpers/escapeHtml';

const MAX_ITEMS_COLLAPSED = 3;

interface ProfileListData {
  folderName: string;
  items: BookmarkItem[];
  isExpanded: boolean;
}

export class ProfileListsComponent {
  private pubkey: string;
  private isOwnProfile: boolean;
  private profileMountsService: ProfileMountsService;
  private profileMountsOrch: ProfileMountsOrchestrator;
  private bookmarkOrch: ReturnType<typeof BookmarkOrchestrator.getInstance>;
  private folderService: ReturnType<typeof getBookmarkFolderService>;
  private authService: AuthService;

  private lists: ProfileListData[] = [];
  private elements: HTMLElement[] = [];
  private insertAfterEl: Element | null = null;

  constructor(pubkey: string) {
    this.pubkey = pubkey;

    this.profileMountsService = ProfileMountsService.getInstance();
    this.profileMountsOrch = ProfileMountsOrchestrator.getInstance();
    this.bookmarkOrch = BookmarkOrchestrator.getInstance();
    this.folderService = getBookmarkFolderService();
    this.authService = AuthService.getInstance();

    this.isOwnProfile = this.authService.isCurrentUser(pubkey);
  }

  /**
   * Render mounted lists into the DOM after the given element
   */
  public async render(insertAfter: Element): Promise<void> {
    this.insertAfterEl = insertAfter;

    try {
      let mountedFolders: string[];

      if (this.isOwnProfile) {
        mountedFolders = this.profileMountsService.getMounts();

        // Sync from relays to catch mounts set on other instances
        try {
          const relayMounts = await this.profileMountsOrch.fetchFromRelays(this.pubkey, true);
          if (relayMounts.length > 0 && JSON.stringify(relayMounts) !== JSON.stringify(mountedFolders)) {
            this.profileMountsService.setMountsFromRelay(relayMounts);
            mountedFolders = relayMounts;
          }
        } catch {
          // Relay fetch failed, use local mounts
        }
      } else {
        mountedFolders = await this.profileMountsOrch.fetchFromRelays(this.pubkey, true);
      }

      if (mountedFolders.length === 0) return;

      await this.loadListItems(mountedFolders);
      this.renderLists();
    } catch (error) {
      console.error('Failed to load profile lists:', error);
    }
  }

  /**
   * Load bookmark items for each mounted folder
   */
  private async loadListItems(folderNames: string[]): Promise<void> {
    this.lists = [];

    if (this.isOwnProfile) {
      const allItems = this.bookmarkOrch.getBrowserItems();
      const folders = this.folderService.getFolders();

      for (const folderName of folderNames) {
        const folder = folders.find(f => f.name === folderName);

        if (folder) {
          const orderedIds = this.folderService.getBookmarksInFolder(folder.id);
          const folderItems = orderedIds
            .map(id => allItems.find(item => item.id === id))
            .filter((item): item is BookmarkItem => item !== undefined && !item.isPrivate);

          if (folderItems.length > 0) {
            this.lists.push({ folderName, items: folderItems, isExpanded: false });
          }
        }
      }
    } else {
      try {
        const fetchResult = await this.bookmarkOrch.fetchBookmarksFromRelays(this.pubkey);

        for (const folderName of folderNames) {
          const folderItems = fetchResult.items.filter(item => {
            const itemCategory = fetchResult.categoryAssignments?.get(item.id) || '';
            return itemCategory === folderName && !item.isPrivate;
          });

          if (folderItems.length > 0) {
            this.lists.push({ folderName, items: folderItems, isExpanded: false });
          }
        }
      } catch (error) {
        console.error('Failed to fetch bookmarks from relays:', error);
      }
    }
  }

  /**
   * Render all lists as individual .profile-lists-mount elements
   */
  private renderLists(): void {
    // Remove previous elements
    this.elements.forEach(el => el.remove());
    this.elements = [];

    if (this.lists.length === 0 || !this.insertAfterEl) return;

    let insertAfter = this.insertAfterEl;
    for (let i = 0; i < this.lists.length; i++) {
      const el = document.createElement('div');
      el.className = 'profile-lists-mount';
      el.dataset.listIndex = String(i);
      el.innerHTML = this.renderListInner(this.lists[i]!, i);
      insertAfter.after(el);
      this.elements.push(el);
      insertAfter = el;
    }

    this.bindEvents();
  }

  /**
   * Render inner HTML for a single list
   */
  private renderListInner(list: ProfileListData, index: number): string {
    const { folderName, items, isExpanded } = list;
    const visibleItems = isExpanded ? items : items.slice(0, MAX_ITEMS_COLLAPSED);
    const hasMore = items.length > MAX_ITEMS_COLLAPSED;

    return `
      <div class="profile-list-header">
        <h2 class="profile-list-title">${escapeHtml(folderName)}</h2>
        ${this.isOwnProfile ? `
          <button class="profile-list-drag-handle" title="Drag to reorder">
            <svg width="12" height="12"><use href="#icon-grid-dots"/></svg>
          </button>
        ` : ''}
      </div>
      <div class="profile-list-items">
        ${visibleItems.map(item => this.renderItem(item)).join('')}
      </div>
      ${hasMore ? `
        <div class="l-row l-row--center">
          <button class="btn btn--passive btn--medium" data-list-index="${index}">
            ${isExpanded ? 'Show less' : `Show more (${items.length - MAX_ITEMS_COLLAPSED})`}
          </button>
        </div>
      ` : ''}
    `;
  }

  /**
   * Render a single item
   */
  private renderItem(item: BookmarkItem): string {
    if (item.type === 'r') {
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
            <svg width="14" height="14"><use href="#icon-share-link"/></svg>
          </span>
          <div class="profile-list-item__content">
            <a href="${url.startsWith('http') ? url : `https://${url}`}" rel="noopener noreferrer" class="profile-list-item__url">
              ${escapeHtml(displayUrl)}
            </a>
            ${description ? `<span class="profile-list-item__desc">${escapeHtml(description)}</span>` : ''}
          </div>
        </div>
      `;
    } else if (item.type === 'e') {
      return `
        <div class="profile-list-item profile-list-item--note">
          <span class="profile-list-item__icon">
            <svg width="14" height="14"><use href="#icon-message"/></svg>
          </span>
          <div class="profile-list-item__content">
            <span class="profile-list-item__id">${item.id.slice(0, 16)}...</span>
          </div>
        </div>
      `;
    } else {
      return `
        <div class="profile-list-item">
          <span class="profile-list-item__icon">•</span>
          <div class="profile-list-item__content">
            <span>${escapeHtml(item.value || item.id)}</span>
          </div>
        </div>
      `;
    }
  }

  /**
   * Bind event listeners
   */
  private bindEvents(): void {
    for (const el of this.elements) {
      el.querySelectorAll('[data-list-index]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const index = parseInt((e.target as HTMLElement).dataset.listIndex || '0');
          this.toggleListExpansion(index);
        });
      });
    }

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
    let draggedSection: HTMLElement | null = null;
    let startY = 0;
    let startIndex = 0;

    for (const section of this.elements) {
      const handle = section.querySelector('.profile-list-drag-handle');
      if (!handle) continue;

      handle.addEventListener('mousedown', (_e: Event) => {
        const mouseEvent = _e as MouseEvent;
        mouseEvent.preventDefault();
        draggedSection = section;
        startY = mouseEvent.clientY;
        startIndex = parseInt(draggedSection.dataset.listIndex || '0');

        draggedSection.classList.add('dragging');
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });
    }

    const onMouseMove = (e: MouseEvent) => {
      if (!draggedSection) return;

      const deltaY = e.clientY - startY;
      draggedSection.style.transform = `translateY(${deltaY}px)`;

      for (const section of this.elements) {
        if (section === draggedSection) continue;
        const rect = section.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;

        if (e.clientY < midY && e.clientY > rect.top) {
          section.classList.add('drop-above');
        } else if (e.clientY > midY && e.clientY < rect.bottom) {
          section.classList.add('drop-below');
        } else {
          section.classList.remove('drop-above', 'drop-below');
        }
      }
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      if (!draggedSection) return;

      let newIndex = startIndex;
      this.elements.forEach((section, index) => {
        if (section.classList.contains('drop-above')) {
          newIndex = index;
        } else if (section.classList.contains('drop-below')) {
          newIndex = index + 1;
        }
        section.classList.remove('drop-above', 'drop-below');
      });

      draggedSection.classList.remove('dragging');
      draggedSection.style.transform = '';

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
    const [moved] = this.lists.splice(fromIndex, 1);
    if (!moved) return;
    this.lists.splice(toIndex > fromIndex ? toIndex - 1 : toIndex, 0, moved);

    const newOrder = this.lists.map(l => l.folderName);
    this.profileMountsService.reorderMounts(newOrder);

    this.profileMountsOrch.publishToRelays().catch(err => {
      console.error('Failed to publish reordered mounts:', err);
    });

    this.renderLists();
  }


  /**
   * Cleanup
   */
  public destroy(): void {
    this.elements.forEach(el => el.remove());
    this.elements = [];
  }
}
