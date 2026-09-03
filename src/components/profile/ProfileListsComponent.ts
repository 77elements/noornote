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

import { ModuleLoader } from '../../core/ModuleLoader';
import type { PostsModuleApi } from '../../modules/posts/contracts';
import type { ProfileModuleApi } from '../../modules/profile/contracts';
import { encodeNaddr, encodeNevent } from '../../services/NostrToolsAdapter';
import {
  BookmarkOrchestrator,
  getBookmarkFolderService,
  type BookmarkItem,
} from '../../lists/bookmarks';
import { AuthService } from '../../services/AuthService';
import { Router } from '../../services/Router';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';

const MAX_ITEMS_COLLAPSED = 3;

interface MountsServiceLike {
  getMounts(): string[];
  setMountsFromRelay(folderNames: string[]): void;
  reorderMounts(newOrder: string[]): void;
}

interface MountsOrchestratorLike {
  fetchFromRelays(pubkey: string, forceRefresh?: boolean): Promise<string[]>;
  publishToRelays(): Promise<void>;
}

interface ProfileListData {
  folderName: string;
  items: BookmarkItem[];
  isExpanded: boolean;
}

export class ProfileListsComponent {
  private pubkey: string;
  private isOwnProfile: boolean;
  private mountsService: MountsServiceLike;
  private mountsOrch: MountsOrchestratorLike;
  private bookmarkOrch: ReturnType<typeof BookmarkOrchestrator.getInstance>;
  private folderService: ReturnType<typeof getBookmarkFolderService>;
  private authService: AuthService;

  private lists: ProfileListData[] = [];
  private elements: HTMLElement[] = [];
  private insertAfterEl: Element | null = null;
  private resolvedDisplay: Map<string, string> = new Map(); // item.id (events) or item.value (a-tags) → display text
  private destroyed: boolean = false;

  constructor(pubkey: string) {
    this.pubkey = pubkey;

    const profileApi =
      ModuleLoader.getInstance().getApi<ProfileModuleApi>('profile');
    this.mountsService = {
      getMounts: () => profileApi?.getProfileMounts() ?? [],
      setMountsFromRelay: () => {
        /* handled by module */
      },
      reorderMounts: newOrder => profileApi?.reorderProfileMounts(newOrder),
    };
    this.mountsOrch = {
      fetchFromRelays: (pk, force) =>
        profileApi?.fetchMountsFromRelays(pk, force) ?? Promise.resolve([]),
      publishToRelays: () =>
        profileApi?.publishMountsToRelays() ?? Promise.resolve(),
    };
    this.bookmarkOrch = BookmarkOrchestrator.getInstance();
    this.folderService = getBookmarkFolderService();
    this.authService = AuthService.getInstance();

    this.isOwnProfile = this.authService.isCurrentUser(pubkey);
  }

  /**
   * Render mounted lists into the DOM. Each list is inserted as a sibling
   * **after** `anchor` — a stable element marking the insertion point on
   * the profile.
   *
   * @param anchor - DOM element used as the insertion reference
   */
  public async render(anchor: Element): Promise<void> {
    this.insertAfterEl = anchor;

    try {
      let mountedFolders: string[];

      if (this.isOwnProfile) {
        // Trust local state. AutoSyncService handles cross-device sync at app
        // boot and on addon toggle. Re-fetching here would race with in-flight
        // publishToRelays from a just-toggled checkbox and revert the change.
        mountedFolders = this.mountsService.getMounts();
      } else {
        mountedFolders = await this.mountsOrch.fetchFromRelays(
          this.pubkey,
          true
        );
      }

      if (mountedFolders.length === 0) return;

      await this.loadListItems(mountedFolders);
      if (this.destroyed) return;
      await this.resolveDisplayNames();
      if (this.destroyed) return;
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
            .filter(
              (item): item is BookmarkItem =>
                item !== undefined && !item.isPrivate
            );

          if (folderItems.length > 0) {
            this.lists.push({
              folderName,
              items: folderItems,
              isExpanded: false,
            });
          }
        }
      }
    } else {
      try {
        const fetchResult = await this.bookmarkOrch.fetchBookmarksFromRelays(
          this.pubkey
        );

        for (const folderName of folderNames) {
          const folderItems = fetchResult.items.filter(item => {
            const itemCategory =
              fetchResult.categoryAssignments?.get(item.id) || '';
            return itemCategory === folderName && !item.isPrivate;
          });

          if (folderItems.length > 0) {
            this.lists.push({
              folderName,
              items: folderItems,
              isExpanded: false,
            });
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

    // Lists become siblings AFTER `anchor`, in order — each new entry
    // appended after the previous so they stay sequential in the DOM.
    let insertAfter: Element = this.insertAfterEl;
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
    const visibleItems = isExpanded
      ? items
      : items.slice(0, MAX_ITEMS_COLLAPSED);
    const hasMore = items.length > MAX_ITEMS_COLLAPSED;

    return `
      <div class="profile-list-header">
        <h2 class="profile-list-title">${escapeHtml(folderName)}</h2>
        ${
          this.isOwnProfile
            ? `
          <button class="profile-list-drag-handle" title="Drag to reorder">
            <svg width="12" height="12"><use href="#icon-grid-dots"/></svg>
          </button>
        `
            : ''
        }
      </div>
      <div class="profile-list-items">
        ${visibleItems.map(item => this.renderItem(item)).join('')}
      </div>
      ${
        hasMore
          ? `
        <div class="l-row l-row--center">
          <button class="btn btn--passive btn--medium" data-list-index="${index}">
            ${isExpanded ? 'Show less' : `Show more (${items.length - MAX_ITEMS_COLLAPSED})`}
          </button>
        </div>
      `
          : ''
      }
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
        displayUrl =
          parsed.hostname + (parsed.pathname !== '/' ? parsed.pathname : '');
      } catch {
        // Keep original
      }

      return `
        <div class="profile-list-item profile-list-item--url">
          <span class="profile-list-item__icon">
            <svg width="14" height="14"><use href="#icon-share-link"/></svg>
          </span>
          <div class="profile-list-item__content">
            <a href="${escapeHtmlAttr(url.startsWith('http') ? url : `https://${url}`)}" rel="noopener noreferrer" class="profile-list-item__url">
              ${escapeHtml(displayUrl)}
            </a>
            ${description ? `<span class="profile-list-item__desc">${escapeHtml(description)}</span>` : ''}
          </div>
        </div>
      `;
    } else if (item.type === 'e') {
      const display =
        this.resolvedDisplay.get(item.id) || `Note ${item.id.slice(0, 8)}…`;
      const navigateTo = `/note/${encodeNevent(item.id)}`;
      return `
        <div class="profile-list-item profile-list-item--note" data-navigate="${navigateTo}" role="link" tabindex="0">
          <span class="profile-list-item__icon">
            <svg width="14" height="14"><use href="#icon-message"/></svg>
          </span>
          <div class="profile-list-item__content">
            <span class="profile-list-item__text">${escapeHtml(display)}</span>
          </div>
        </div>
      `;
    } else if (item.type === 'a' && item.value?.startsWith('30402:')) {
      const display =
        this.resolvedDisplay.get(item.value) || 'Untitled listing';
      const parts = item.value.split(':');
      let navigateTo = '';
      if (parts.length >= 3) {
        try {
          const naddr = encodeNaddr({
            kind: 30402,
            pubkey: parts[1]!,
            identifier: parts.slice(2).join(':'),
          });
          navigateTo = `/listing/${naddr}`;
        } catch {
          // Encoding failed — render without navigation
        }
      }
      return `
        <div class="profile-list-item profile-list-item--product"${navigateTo ? ` data-navigate="${navigateTo}" role="link" tabindex="0"` : ''}>
          <span class="profile-list-item__icon">
            <svg width="14" height="14"><use href="#icon-shopping-bag"/></svg>
          </span>
          <div class="profile-list-item__content">
            <span class="profile-list-item__text">${escapeHtml(display)}</span>
          </div>
        </div>
      `;
    } else {
      return `
        <div class="profile-list-item">
          <span class="profile-list-item__icon">•</span>
          <div class="profile-list-item__content">
            <span class="profile-list-item__text">${escapeHtml(item.value || item.id)}</span>
          </div>
        </div>
      `;
    }
  }

  /**
   * Batch-resolve display labels for note bookmarks ('e') and NIP-99 listings ('a' with kind 30402).
   * URL bookmarks need no resolution.
   */
  private async resolveDisplayNames(): Promise<void> {
    const noteIds = new Set<string>();
    const listingAddrs = new Set<string>();

    for (const list of this.lists) {
      for (const item of list.items) {
        if (item.type === 'e') {
          noteIds.add(item.id);
        } else if (item.type === 'a' && item.value?.startsWith('30402:')) {
          listingAddrs.add(item.value);
        }
      }
    }

    const work: Promise<void>[] = [];

    if (noteIds.size > 0) {
      work.push(
        (async () => {
          try {
            const postsApi =
              ModuleLoader.getInstance().getApi<PostsModuleApi>('posts');
            const notes =
              (await postsApi?.getNotes(Array.from(noteIds))) ??
              new Map<string, import('@nostr-dev-kit/ndk').NostrEvent>();
            for (const [id, event] of notes.entries()) {
              const firstLine =
                (event.content || '')
                  .split('\n')
                  .map(l => l.trim())
                  .find(l => l.length > 0) || '';
              this.resolvedDisplay.set(
                id,
                firstLine || `Note ${id.slice(0, 8)}…`
              );
            }
          } catch {
            // Leave fallback display
          }
        })()
      );
    }

    if (listingAddrs.size > 0) {
      work.push(
        (async () => {
          try {
            const profileApi =
              ModuleLoader.getInstance().getApi<ProfileModuleApi>('profile');
            const events =
              (await profileApi?.fetchAddressableEvents(
                Array.from(listingAddrs)
              )) ?? [];

            for (const event of events) {
              const dTag = event.tags.find(t => t[0] === 'd')?.[1] || '';
              const titleTag = event.tags.find(t => t[0] === 'title')?.[1];
              const addr = `${event.kind}:${event.pubkey}:${dTag}`;
              this.resolvedDisplay.set(addr, titleTag || 'Untitled listing');
            }
          } catch {
            // Leave fallback display
          }
        })()
      );
    }

    await Promise.all(work);
  }

  /**
   * Bind event listeners
   */
  private bindEvents(): void {
    for (const el of this.elements) {
      el.querySelectorAll('[data-list-index]').forEach(btn => {
        btn.addEventListener('click', e => {
          const index = parseInt(
            (e.target as HTMLElement).dataset.listIndex || '0'
          );
          this.toggleListExpansion(index);
        });
      });

      // Note + product items navigate to detail view on click
      el.querySelectorAll<HTMLElement>(
        '.profile-list-item[data-navigate]'
      ).forEach(itemEl => {
        const handler = () => {
          const target = itemEl.dataset.navigate;
          if (target) Router.getInstance().navigate(target);
        };
        itemEl.addEventListener('click', handler);
        itemEl.addEventListener('keydown', e => {
          if (
            (e as KeyboardEvent).key === 'Enter' ||
            (e as KeyboardEvent).key === ' '
          ) {
            e.preventDefault();
            handler();
          }
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
    this.mountsService.reorderMounts(newOrder);

    this.mountsOrch.publishToRelays().catch(err => {
      console.error('Failed to publish reordered mounts:', err);
    });

    this.renderLists();
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    this.destroyed = true;
    this.elements.forEach(el => el.remove());
    this.elements = [];
  }
}
