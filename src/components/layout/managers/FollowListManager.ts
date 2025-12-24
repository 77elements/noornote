/**
 * FollowListSecondaryManager
 * Manages follow list tab in secondary-content sidebar
 * Uses ListSyncManager for Browser ↔ File ↔ Relay synchronization
 * Implements infinite scroll for large lists
 * Shows mutual status and zap stats for each follow
 *
 * @purpose Handle follow list rendering, sync operations, and unfollow
 * @used-by MainLayout
 */

import { BaseListSecondaryManager } from './BaseListSecondaryManager';
import { FollowListOrchestrator } from '../../../services/orchestration/FollowListOrchestrator';
import { UserProfileService } from '../../../services/UserProfileService';
import { MutualService } from '../../../services/MutualService';
import { MutualChangeDetector } from '../../../services/MutualChangeDetector';
import { MutualChangeStorage } from '../../../services/storage/MutualChangeStorage';
import { ZapStatsService } from '../../../services/ZapStatsService';
import { ToastService } from '../../../services/ToastService';
import { Router } from '../../../services/Router';
import { hexToNpub } from '../../../helpers/nip19';
import { extractDisplayName } from '../../../helpers/extractDisplayName';
import { ListSyncManager } from '../../../services/sync/ListSyncManager';
import { FollowStorageAdapter } from '../../../services/sync/adapters/FollowStorageAdapter';
import { RestoreListsService } from '../../../services/RestoreListsService';
import { InfiniteScroll } from '../../ui/InfiniteScroll';
import { ProgressBarHelper } from '../../../helpers/ProgressBarHelper';
import { ArticleNotificationService } from '../../../services/ArticleNotificationService';
import { renderUserMention, setupUserMentionHandlers } from '../../../helpers/UserMentionHelper';
import type { FollowItem } from '../../../services/storage/FollowFileStorage';
import type { UserProfile } from '../../../services/UserProfileService';

interface FollowItemWithProfile {
  pubkey: string;
  relay?: string;
  petname?: string;
  addedAt?: number;
  profile: UserProfile;
  isPrivate: boolean;
  isMutual: boolean;
}

export class FollowListSecondaryManager extends BaseListSecondaryManager<FollowItem, FollowItemWithProfile> {
  private followOrch: FollowListOrchestrator;
  private userProfileService: UserProfileService;
  private mutualService: MutualService;
  private mutualChangeDetector: MutualChangeDetector;
  private mutualChangeStorage: MutualChangeStorage;
  private zapStatsService: ZapStatsService;
  private router: Router;
  private adapter: FollowStorageAdapter;

  // Stats and filter
  private totalFollowing: number = 0;
  private mutualCount: number = 0;
  private showOnlyNonMutuals: boolean = false;
  private zapStatsLoaded: boolean = false;

  // Sorting and loading state
  private isFullyLoaded: boolean = false;
  private currentSort: 'date' | 'zaps' = 'date';
  private isLoadingAll: boolean = false;
  private originalOrder: string[] = []; // Store original pubkey order for date sorting
  private usernameFilter: string = ''; // Filter by username

  constructor(containerElement: HTMLElement) {
    const adapter = new FollowStorageAdapter();
    const listSyncManager = new ListSyncManager(adapter);

    super(containerElement, listSyncManager);

    this.adapter = adapter;
    this.followOrch = FollowListOrchestrator.getInstance();
    this.userProfileService = UserProfileService.getInstance();
    this.mutualService = MutualService.getInstance();
    this.mutualChangeDetector = MutualChangeDetector.getInstance();
    this.mutualChangeStorage = MutualChangeStorage.getInstance();
    this.zapStatsService = ZapStatsService.getInstance();
    this.router = Router.getInstance();

    // Additional user:login handler for follow-specific caches
    this.eventBus.on('user:login', () => {
      this.totalFollowing = 0;
      this.mutualCount = 0;
      this.zapStatsLoaded = false;
      this.isFullyLoaded = false;
      this.originalOrder = [];
      this.usernameFilter = '';
    });

    // Listen for zap stats loaded event
    this.eventBus.on('zapstats:loaded', () => {
      this.zapStatsLoaded = true;
      this.updateAllZapBadges();
      // Update sort controls to enable "Sort by Zaps" if fully loaded
      const container = this.containerElement.querySelector('[data-tab-content="list-follows"]') as HTMLElement;
      if (container) {
        this.updateSortControlsUI(container);
      }
    });

    // Listen for mutual changes detected (update green dot)
    this.eventBus.on('mutual-changes:detected', () => {
      this.updateGreenDot();
    });

    // Listen for mutual changes seen (remove green dot)
    this.eventBus.on('mutual-changes:seen', () => {
      this.updateGreenDot();
    });
  }

  /**
   * Abstract method implementations
   */

  protected getEventName(): string {
    return 'follow:updated';
  }

  protected getTabDataAttribute(): string {
    return 'list-follows';
  }

  protected getListContainerClass(): string {
    return 'follows-list';
  }

  protected getListType(): string {
    return 'Follows';
  }

  protected async getDisplayNameForSync(item: FollowItem): Promise<string> {
    const profile = await this.userProfileService.getUserProfile(item.pubkey);
    return extractDisplayName(profile);
  }

  /**
   * Fetch all follows with profiles and mutual status
   */
  protected async getAllItemsWithProfiles(): Promise<FollowItemWithProfile[]> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) throw new Error('User not authenticated');

    // Use RestoreListsService for cascading restore (browser → file → relays)
    const restoreService = RestoreListsService.getInstance();
    await restoreService.restoreIfEmpty(
      this.listSyncManager,
      () => this.adapter.getBrowserItems(),
      (items) => this.adapter.setBrowserItems(items),
      'Follows'
    );

    // Read from browser storage (localStorage) - source of truth during session
    const allFollows = this.adapter.getBrowserItems();

    // Get public/private status from files (fallback for items without browser flag)
    const followStatus = await this.followOrch.getAllFollowsWithStatus();

    // Fetch profiles for all followed users
    const followsWithProfiles: FollowItemWithProfile[] = await Promise.all(
      allFollows.map(async (item) => {
        // Priority: browser item's isPrivate flag, then file status
        const fileStatus = followStatus.get(item.pubkey);
        const isPrivate = item.isPrivate !== undefined
          ? item.isPrivate
          : (fileStatus?.private === true);

        return {
          ...item,
          profile: await this.userProfileService.getUserProfile(item.pubkey),
          isPrivate,
          isMutual: false // Will be updated per batch
        };
      })
    );

    // Reverse to show newest first (tag order in Kind 3 = chronological, oldest first)
    followsWithProfiles.reverse();

    // Store total count
    this.totalFollowing = followsWithProfiles.length;

    return followsWithProfiles;
  }

  /**
   * Override renderListTab to add sticky header with stats and filter
   */
  protected override async renderListTab(container: HTMLElement): Promise<void> {
    // Initialize browser storage from file on first render
    await this.initializeBrowserStorage();

    // Clean up existing infinite scroll
    if (this.infiniteScroll) {
      this.infiniteScroll.destroy();
      this.infiniteScroll = null;
    }

    // Reset state
    this.allItemsWithProfiles = [];
    this.currentOffset = 0;
    this.hasMore = true;
    this.isLoading = false;
    this.mutualCount = 0;
    this.zapStatsLoaded = false;
    this.isFullyLoaded = false;
    this.currentSort = 'date';
    this.isLoadingAll = false;

    // Clear unseen changes when tab is opened
    if (this.mutualChangeStorage.hasUnseenChanges()) {
      this.mutualChangeStorage.setUnseenChanges(false);
      this.updateGreenDot();
    }

    try {
      const currentUser = this.authService.getCurrentUser();

      if (!currentUser) {
        container.innerHTML = `
          <div class="follows-list-empty-state">
            <p>Log in to see your follows</p>
          </div>
        `;
        return;
      }

      // Show loading state
      container.innerHTML = `
        <div class="follows-list-loading">
          Loading follows...
        </div>
      `;

      // Fetch all items with profiles
      const itemsWithProfiles = await this.getAllItemsWithProfiles();

      if (itemsWithProfiles.length === 0) {
        container.innerHTML = this.renderControlButtons() + `
          <div class="follows-list-empty-state">
            <p>No follows yet</p>
          </div>
        ` + this.renderControlButtons();
        this.bindSyncButtons(container);
        return;
      }

      // Store all items for batch loading
      this.allItemsWithProfiles = itemsWithProfiles;

      // Store original order for date sorting
      this.originalOrder = itemsWithProfiles.map(item => item.pubkey);

      // Get last check info for display
      const lastCheckTimestamp = this.mutualChangeStorage.getLastCheckTimestamp();
      const lastCheckText = lastCheckTimestamp ? this.formatTimeAgo(lastCheckTimestamp) : 'Never';

      // Render container with sticky header, controls and list
      container.innerHTML = `
        <div class="follows-header">
          <div class="follows-stats">
            Following: ${this.totalFollowing} | Mutuals: <span class="mutual-count">...</span> (<span class="mutual-percentage">...</span>%)
          </div>
          <div class="follows-check-changes">
            <a href="#" class="follows-check-changes__link">Check for changes</a>
            <span class="follows-check-changes__last-check">Last: ${lastCheckText}</span>
          </div>
        </div>
        ${this.renderControlButtons()}
        <div class="follows-sort-controls">
          <a href="#" class="follows-sort-controls__load-all">Load all</a>
          <span class="follows-sort-controls__sort">
            Sort by:
            <a href="#" class="follows-sort-controls__sort-date follows-sort-controls__link--disabled ${this.currentSort === 'date' ? 'active' : ''}">Date</a>
            /
            <a href="#" class="follows-sort-controls__sort-zaps follows-sort-controls__link--disabled ${this.currentSort === 'zaps' ? 'active' : ''}">Zaps</a>
          </span>
          <input type="text"
                 class="follows-sort-controls__search ${this.isFullyLoaded ? '' : 'follows-sort-controls__search--disabled'}"
                 placeholder="Filter by name..."
                 ${this.isFullyLoaded ? '' : 'disabled'} />
          <label class="follows-sort-controls__non-mutuals ${this.isFullyLoaded ? '' : 'follows-sort-controls__non-mutuals--disabled'}">
            <input type="checkbox" class="follows-filter__toggle" ${this.showOnlyNonMutuals ? 'checked' : ''} ${this.isFullyLoaded ? '' : 'disabled'}>
            Non-mutuals only
          </label>
        </div>
        <div class="follows-list"></div>
        ${this.renderControlButtons()}
        <div class="mutual-changes-modal" style="display: none;"></div>
      `;

      // Bind sync button handlers
      this.bindSyncButtons(container);

      // Bind filter toggle
      const filterToggle = container.querySelector('.follows-filter__toggle') as HTMLInputElement;
      filterToggle?.addEventListener('change', () => {
        this.showOnlyNonMutuals = filterToggle.checked;
        this.reRenderList(container);
      });

      // Bind sort controls
      this.bindSortControls(container);

      // Bind check for changes link
      this.bindCheckForChanges(container);

      const list = container.querySelector('.follows-list');
      if (!list) return;

      // Load first batch
      await this.loadBatch(list as HTMLElement);

      // Update stats
      this.updateStats(container);

      // Setup infinite scroll if there are more items
      if (this.hasMore) {
        this.infiniteScroll = new InfiniteScroll(() => this.handleLoadMore(), {
          loadingMessage: 'Loading more follows...'
        });
        this.infiniteScroll.observe(list as HTMLElement);
      }

      // Start loading zap stats asynchronously (don't await)
      const allPubkeys = this.allItemsWithProfiles.map(item => item.pubkey);
      this.zapStatsService.loadStatsForPubkeys(allPubkeys);
    } catch (error) {
      console.error('Failed to render follows:', error);
      container.innerHTML = `
        <div class="follows-list-empty-state">
          <p>Failed to load follows</p>
        </div>
      `;
    }
  }

  /**
   * Bind "Check for Changes" link handler
   */
  private bindCheckForChanges(container: HTMLElement): void {
    const checkLink = container.querySelector('.follows-check-changes__link');
    checkLink?.addEventListener('click', async (e) => {
      e.preventDefault();
      await this.handleCheckForChanges(container);
    });
  }

  /**
   * Handle "Check for Changes" click
   */
  private async handleCheckForChanges(container: HTMLElement): Promise<void> {
    const checkLink = container.querySelector('.follows-check-changes__link');
    const lastCheckSpan = container.querySelector('.follows-check-changes__last-check');

    if (checkLink) {
      checkLink.textContent = 'Checking...';
      (checkLink as HTMLElement).style.pointerEvents = 'none';
    }

    try {
      const result = await this.mutualChangeDetector.detect();

      // Update last check text
      if (lastCheckSpan) {
        lastCheckSpan.textContent = 'Last: Just now';
      }

      if (result.isFirstCheck) {
        ToastService.show('Initial snapshot saved. Changes will be detected on next check.', 'info');
      } else if (result.totalChanges === 0) {
        ToastService.show('No changes detected', 'success');
      } else {
        // Show modal with results
        this.showChangesModal(container, result);
      }
    } catch (error) {
      console.error('Failed to check for changes:', error);
      ToastService.show('Failed to check for changes', 'error');
    } finally {
      if (checkLink) {
        checkLink.textContent = 'Check for changes';
        (checkLink as HTMLElement).style.pointerEvents = '';
      }
    }
  }

  /**
   * Show modal with detected changes
   */
  private async showChangesModal(
    container: HTMLElement,
    result: { unfollows: string[]; newMutuals: string[]; totalChanges: number }
  ): Promise<void> {
    const modal = container.querySelector('.mutual-changes-modal') as HTMLElement;
    if (!modal) return;

    // Fetch profiles for display (keep pubkey + profile together)
    const unfollowData = await Promise.all(
      result.unfollows.map(async (pubkey) => {
        const profile = await this.userProfileService.getUserProfile(pubkey);
        return {
          pubkey,
          username: extractDisplayName(profile),
          avatarUrl: profile?.picture || ''
        };
      })
    );

    const newMutualData = await Promise.all(
      result.newMutuals.map(async (pubkey) => {
        const profile = await this.userProfileService.getUserProfile(pubkey);
        return {
          pubkey,
          username: extractDisplayName(profile),
          avatarUrl: profile?.picture || ''
        };
      })
    );

    modal.innerHTML = `
      <div class="mutual-changes-modal__backdrop"></div>
      <div class="mutual-changes-modal__content">
        <h3>Mutual Changes Detected</h3>
        <p class="mutual-changes-modal__summary">
          ${result.totalChanges} ${result.totalChanges === 1 ? 'change' : 'changes'} detected
        </p>

        ${newMutualData.length > 0 ? `
          <div class="mutual-changes-modal__section mutual-changes-modal__section--positive">
            <h4>New Mutuals (${newMutualData.length})</h4>
            <ul class="mutual-changes-modal__list">
              ${newMutualData.map(data => `
                <li class="mutual-changes-modal__item mutual-changes-modal__item--positive">
                  ${renderUserMention(data.pubkey, { username: data.username, avatarUrl: data.avatarUrl })} started following you back!
                </li>
              `).join('')}
            </ul>
          </div>
        ` : ''}

        ${unfollowData.length > 0 ? `
          <div class="mutual-changes-modal__section mutual-changes-modal__section--negative">
            <h4>Unfollows (${unfollowData.length})</h4>
            <ul class="mutual-changes-modal__list">
              ${unfollowData.map(data => `
                <li class="mutual-changes-modal__item mutual-changes-modal__item--negative">
                  ${renderUserMention(data.pubkey, { username: data.username, avatarUrl: data.avatarUrl })} stopped following back
                </li>
              `).join('')}
            </ul>
          </div>
        ` : ''}

        <div class="mutual-changes-modal__actions">
          <button class="btn btn--primary mutual-changes-modal__mark-seen">Mark as Seen</button>
          <button class="btn btn--passive mutual-changes-modal__close">Close</button>
        </div>
      </div>
    `;

    modal.style.display = 'flex';

    // Setup click handlers and hover cards for user mentions
    setupUserMentionHandlers(modal);

    // Event listeners
    modal.querySelector('.mutual-changes-modal__mark-seen')?.addEventListener('click', async () => {
      await this.mutualChangeDetector.markAsSeen();
      modal.style.display = 'none';
      ToastService.show('Changes marked as seen', 'success');
    });

    modal.querySelector('.mutual-changes-modal__close')?.addEventListener('click', () => {
      modal.style.display = 'none';
    });

    modal.querySelector('.mutual-changes-modal__backdrop')?.addEventListener('click', () => {
      modal.style.display = 'none';
    });
  }

  /**
   * Update green dot indicator in sidebar
   */
  private updateGreenDot(): void {
    const hasUnseen = this.mutualChangeStorage.hasUnseenChanges();

    // Find the follows tab button in sidebar and update dot
    const tabButton = document.querySelector('[data-tab="list-follows"]');
    if (tabButton) {
      const existingDot = tabButton.querySelector('.follows-unseen-dot');
      if (hasUnseen && !existingDot) {
        const dot = document.createElement('span');
        dot.className = 'follows-unseen-dot';
        tabButton.appendChild(dot);
      } else if (!hasUnseen && existingDot) {
        existingDot.remove();
      }
    }
  }

  /**
   * Format timestamp as relative time
   */
  private formatTimeAgo(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'Just now';
  }

  /**
   * Override loadBatch to check mutual status per batch
   */
  protected override async loadBatch(listElement: HTMLElement): Promise<void> {
    if (this.isLoading || !this.hasMore) return;

    this.isLoading = true;

    if (this.currentOffset > 0 && this.infiniteScroll) {
      this.infiniteScroll.showLoading();
    }

    try {
      // Get next batch
      const batch = this.allItemsWithProfiles.slice(
        this.currentOffset,
        this.currentOffset + this.BATCH_SIZE
      );

      if (batch.length === 0) {
        this.hasMore = false;
        if (this.infiniteScroll) {
          this.infiniteScroll.hideLoading();
        }
        return;
      }

      // Check mutual status for this batch
      const batchWithMutualStatus = await this.mutualService.checkMutualStatusBatch(
        batch.map(item => ({ pubkey: item.pubkey }))
      );

      // Update items with mutual status
      batch.forEach((item, idx) => {
        item.isMutual = batchWithMutualStatus[idx]?.isMutual ?? false;
        if (item.isMutual) {
          this.mutualCount++;
        }
      });

      // Render batch
      this.renderBatch(listElement, batch);

      // Update offset
      this.currentOffset += batch.length;

      // Check if there are more items
      if (this.currentOffset >= this.allItemsWithProfiles.length) {
        this.hasMore = false;
      }

      // Update stats
      const container = listElement.closest('[data-tab-content]') as HTMLElement;
      if (container) {
        this.updateStats(container);
      }
    } catch (error) {
      console.error('Failed to load batch:', error);
    } finally {
      this.isLoading = false;
      if (this.infiniteScroll) {
        this.infiniteScroll.hideLoading();
      }
    }
  }

  /**
   * Render batch of follow items with mutual badge and zap stats
   */
  protected renderBatch(listElement: HTMLElement, batch: FollowItemWithProfile[]): void {
    for (const item of batch) {
      // Skip if filter is active and item is mutual
      if (this.showOnlyNonMutuals && item.isMutual) {
        continue;
      }

      const username = extractDisplayName(item.profile);
      const npub = hexToNpub(item.pubkey);
      const avatarUrl = item.profile?.picture || '';

      const mutualBadgeClass = item.isMutual ? 'mutual-badge--yes' : 'mutual-badge--no';
      const mutualBadgeText = item.isMutual ? 'Mutual' : 'Not following back';

      // Zap badge - loading or actual values
      const zapBadgeHtml = this.renderZapBadge(item.pubkey);

      const followItemDiv = document.createElement('div');
      followItemDiv.className = 'ui-list__item follow-item';
      followItemDiv.dataset.pubkey = item.pubkey;
      followItemDiv.innerHTML = `
        <div class="follow-item__content-wrapper">
          <div class="follow-item__avatar">
            <img class="profile-pic profile-pic--medium" src="${avatarUrl}" alt="${username}" />
          </div>
          <div class="follow-item__info">
            <div class="follow-item__username">
              ${this.escapeHtml(username)}
              ${item.isPrivate ? '<span class="private-badge">🔒 Private</span>' : ''}
              ${this.renderArticleNotifLabel(item.pubkey)}
            </div>
            <div class="follow-item__badges">
              <span class="mutual-badge ${mutualBadgeClass}">${mutualBadgeText}</span>
              ${zapBadgeHtml}
            </div>
            ${item.petname ? `<div class="follow-item__petname">${this.escapeHtml(item.petname)}</div>` : ''}
          </div>
        </div>
        <button class="follow-item__unfollow-btn btn btn--passive btn--medium" data-pubkey="${item.pubkey}">
          Disconnect
        </button>
      `;

      // Click on content wrapper navigates to profile
      const contentWrapper = followItemDiv.querySelector('.follow-item__content-wrapper');
      contentWrapper?.addEventListener('click', () => {
        this.router.navigate(`/profile/${npub}`);
      });

      // Click on unfollow button removes follow
      const unfollowBtn = followItemDiv.querySelector('.follow-item__unfollow-btn');
      unfollowBtn?.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.handleRemoveItem(item, followItemDiv);
      });

      // Insert before sentinel (if it exists)
      const sentinel = listElement.querySelector('.infinite-scroll-sentinel');
      if (sentinel) {
        listElement.insertBefore(followItemDiv, sentinel);
      } else {
        listElement.appendChild(followItemDiv);
      }
    }
  }

  /**
   * Render zap badge HTML
   */
  private renderZapBadge(pubkey: string): string {
    if (!this.zapStatsLoaded) {
      // Loading state with pulsing animation
      return `<span class="zap-stats-badge zap-stats-badge--loading" data-pubkey="${pubkey}">Zaps: Loading...</span>`;
    }

    const stats = this.zapStatsService.getStats(pubkey);
    if (!stats) {
      return `<span class="zap-stats-badge" data-pubkey="${pubkey}">Zaps: In (0) 0 | Out (0) 0</span>`;
    }

    const inSats = this.zapStatsService.formatSats(stats.incomingSats);
    const outSats = this.zapStatsService.formatSats(stats.outgoingSats);

    return `<span class="zap-stats-badge" data-pubkey="${pubkey}">Zaps: In (${stats.incomingCount}) ${inSats} | Out (${stats.outgoingCount}) ${outSats}</span>`;
  }

  /**
   * Update all zap badges after stats are loaded
   */
  private updateAllZapBadges(): void {
    const badges = this.containerElement.querySelectorAll('.zap-stats-badge');
    badges.forEach(badge => {
      const pubkey = badge.getAttribute('data-pubkey');
      if (!pubkey) return;

      const stats = this.zapStatsService.getStats(pubkey);
      badge.classList.remove('zap-stats-badge--loading');

      if (!stats) {
        badge.textContent = 'Zaps: In (0) 0 | Out (0) 0';
        return;
      }

      const inSats = this.zapStatsService.formatSats(stats.incomingSats);
      const outSats = this.zapStatsService.formatSats(stats.outgoingSats);
      badge.textContent = `Zaps: In (${stats.incomingCount}) ${inSats} | Out (${stats.outgoingCount}) ${outSats}`;
    });
  }

  /**
   * Re-render list (for filter toggle)
   */
  private reRenderList(container: HTMLElement): void {
    const list = container.querySelector('.follows-list');
    if (!list) return;

    // Clear list (keep sentinel)
    const sentinel = list.querySelector('.infinite-scroll-sentinel');
    list.innerHTML = '';
    if (sentinel) {
      list.appendChild(sentinel);
    }

    // Re-render all loaded items with filter
    for (const item of this.allItemsWithProfiles.slice(0, this.currentOffset)) {
      if (this.showOnlyNonMutuals && item.isMutual) {
        continue;
      }

      // Username filter (case insensitive)
      if (this.usernameFilter) {
        const username = extractDisplayName(item.profile).toLowerCase();
        if (!username.includes(this.usernameFilter)) {
          continue;
        }
      }

      const username = extractDisplayName(item.profile);
      const npub = hexToNpub(item.pubkey);
      const avatarUrl = item.profile?.picture || '';

      const mutualBadgeClass = item.isMutual ? 'mutual-badge--yes' : 'mutual-badge--no';
      const mutualBadgeText = item.isMutual ? 'Mutual' : 'Not following back';

      // Zap badge
      const zapBadgeHtml = this.renderZapBadge(item.pubkey);

      const followItemDiv = document.createElement('div');
      followItemDiv.className = 'ui-list__item follow-item';
      followItemDiv.dataset.pubkey = item.pubkey;
      followItemDiv.innerHTML = `
        <div class="follow-item__content-wrapper">
          <div class="follow-item__avatar">
            <img class="profile-pic profile-pic--medium" src="${avatarUrl}" alt="${username}" />
          </div>
          <div class="follow-item__info">
            <div class="follow-item__username">
              ${this.escapeHtml(username)}
              ${item.isPrivate ? '<span class="private-badge">🔒 Private</span>' : ''}
              ${this.renderArticleNotifLabel(item.pubkey)}
            </div>
            <div class="follow-item__badges">
              <span class="mutual-badge ${mutualBadgeClass}">${mutualBadgeText}</span>
              ${zapBadgeHtml}
            </div>
            ${item.petname ? `<div class="follow-item__petname">${this.escapeHtml(item.petname)}</div>` : ''}
          </div>
        </div>
        <button class="follow-item__unfollow-btn btn btn--passive btn--medium" data-pubkey="${item.pubkey}">
          Disconnect
        </button>
      `;

      // Click on content wrapper navigates to profile
      const contentWrapper = followItemDiv.querySelector('.follow-item__content-wrapper');
      contentWrapper?.addEventListener('click', () => {
        this.router.navigate(`/profile/${npub}`);
      });

      // Click on unfollow button removes follow
      const unfollowBtn = followItemDiv.querySelector('.follow-item__unfollow-btn');
      unfollowBtn?.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.handleRemoveItem(item, followItemDiv);
      });

      if (sentinel) {
        list.insertBefore(followItemDiv, sentinel);
      } else {
        list.appendChild(followItemDiv);
      }
    }
  }

  /**
   * Update stats display
   */
  private updateStats(container: HTMLElement): void {
    const percentage = this.totalFollowing > 0
      ? Math.round((this.mutualCount / this.totalFollowing) * 100)
      : 0;

    const countEl = container.querySelector('.mutual-count');
    const percentEl = container.querySelector('.mutual-percentage');

    if (countEl) countEl.textContent = String(this.mutualCount);
    if (percentEl) percentEl.textContent = String(percentage);
  }

  /**
   * Handle unfollow (remove item)
   * Updates browser storage (localStorage) - use "Save to file" / "Sync to Relays" to persist
   */
  protected async handleRemoveItem(item: FollowItemWithProfile, itemElement: HTMLElement): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return;

    try {
      // Remove from browser storage (localStorage)
      const currentItems = this.listSyncManager['adapter'].getBrowserItems();
      const updatedItems = currentItems.filter((f: FollowItem) => f.pubkey !== item.pubkey);
      this.listSyncManager['adapter'].setBrowserItems(updatedItems);

      ToastService.show('Unfollowed user', 'success');

      itemElement.remove();

      // Update cached list and stats
      if (item.isMutual) {
        this.mutualCount--;
      }
      this.totalFollowing--;
      this.allItemsWithProfiles = this.allItemsWithProfiles.filter(f => f.pubkey !== item.pubkey);

      // Update stats display
      const container = this.containerElement.querySelector('[data-tab-content="list-follows"]') as HTMLElement;
      if (container) {
        this.updateStats(container);
        // Update total in header
        const statsEl = container.querySelector('.follows-stats');
        if (statsEl) {
          const percentage = this.totalFollowing > 0
            ? Math.round((this.mutualCount / this.totalFollowing) * 100)
            : 0;
          statsEl.innerHTML = `Following: ${this.totalFollowing} | Mutuals: <span class="mutual-count">${this.mutualCount}</span> (<span class="mutual-percentage">${percentage}</span>%)`;
        }
      }

      this.eventBus.emit('follow:updated', {});
    } catch (error) {
      console.error('Failed to unfollow user:', error);
      ToastService.show('Failed to unfollow user', 'error');
    }
  }

  /**
   * Handle tab switch (called by MainLayout)
   */
  public handleTabSwitch(tabName: string, content: HTMLElement): void {
    if (tabName === 'follows') {
      this.renderListTab(content).catch(err => {
        console.error('Failed to render follows tab:', err);
      });
    }
  }

  /**
   * Bind sort control event handlers
   */
  private bindSortControls(container: HTMLElement): void {
    // Load all link
    const loadAllLink = container.querySelector('.follows-sort-controls__load-all');
    loadAllLink?.addEventListener('click', (e) => {
      e.preventDefault();
      this.handleLoadAll(container);
    });

    // Sort by Date link
    const sortDateLink = container.querySelector('.follows-sort-controls__sort-date');
    sortDateLink?.addEventListener('click', (e) => {
      e.preventDefault();
      if (this.isFullyLoaded && this.currentSort !== 'date') {
        this.currentSort = 'date';
        this.sortByDate();
        this.updateSortControlsUI(container);
        this.reRenderList(container);
      }
    });

    // Sort by Zaps link (requires both fully loaded AND zap stats loaded)
    const sortZapsLink = container.querySelector('.follows-sort-controls__sort-zaps');
    sortZapsLink?.addEventListener('click', (e) => {
      e.preventDefault();
      if (this.isFullyLoaded && this.zapStatsLoaded && this.currentSort !== 'zaps') {
        this.currentSort = 'zaps';
        this.sortByZaps();
        this.updateSortControlsUI(container);
        this.reRenderList(container);
      }
    });

    // Username filter input
    const searchInput = container.querySelector('.follows-sort-controls__search') as HTMLInputElement;
    searchInput?.addEventListener('input', () => {
      this.usernameFilter = searchInput.value.toLowerCase();
      this.reRenderList(container);
    });
  }

  /**
   * Load all items in background
   */
  private async handleLoadAll(container: HTMLElement): Promise<void> {
    if (this.isLoadingAll || this.isFullyLoaded) return;

    this.isLoadingAll = true;

    // Update link text to show loading
    const loadAllLink = container.querySelector('.follows-sort-controls__load-all');
    if (loadAllLink) {
      loadAllLink.textContent = 'Loading...';
      loadAllLink.classList.add('follows-sort-controls__load-all--loading');
    }

    // Start progress bar
    const sortControls = container.querySelector('.follows-sort-controls') as HTMLElement;
    const progressBar = sortControls ? new ProgressBarHelper(sortControls) : null;
    progressBar?.start();

    const list = container.querySelector('.follows-list') as HTMLElement;
    if (!list) return;

    const totalItems = this.allItemsWithProfiles.length;

    // Load all remaining batches
    while (this.hasMore && !this.isLoading) {
      await this.loadBatch(list);

      // Update progress bar
      if (progressBar && totalItems > 0) {
        const progress = (this.currentOffset / totalItems) * 100;
        progressBar.update(progress);
      }

      // Small delay to prevent UI freezing
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    this.isFullyLoaded = true;
    this.isLoadingAll = false;

    // Complete progress bar with fade-out
    progressBar?.complete();

    // Update UI
    if (loadAllLink) {
      loadAllLink.textContent = 'All loaded';
      loadAllLink.classList.remove('follows-sort-controls__load-all--loading');
      loadAllLink.classList.add('follows-sort-controls__load-all--done');
    }

    // Enable sort controls
    this.updateSortControlsUI(container);
  }

  /**
   * Update sort controls UI state
   */
  private updateSortControlsUI(container: HTMLElement): void {
    const sortDateLink = container.querySelector('.follows-sort-controls__sort-date') as HTMLElement;
    const sortZapsLink = container.querySelector('.follows-sort-controls__sort-zaps') as HTMLElement;
    const searchInput = container.querySelector('.follows-sort-controls__search') as HTMLInputElement;
    const nonMutualsLabel = container.querySelector('.follows-sort-controls__non-mutuals');
    const nonMutualsCheckbox = nonMutualsLabel?.querySelector('input') as HTMLInputElement;

    // Enable Date sort when fully loaded
    if (this.isFullyLoaded) {
      sortDateLink?.classList.remove('follows-sort-controls__link--disabled');

      if (searchInput) {
        searchInput.disabled = false;
        searchInput.classList.remove('follows-sort-controls__search--disabled');
      }
      if (nonMutualsLabel && nonMutualsCheckbox) {
        nonMutualsLabel.classList.remove('follows-sort-controls__non-mutuals--disabled');
        nonMutualsCheckbox.disabled = false;
      }
    }

    // Zaps sort requires both fully loaded AND zap stats loaded
    if (this.isFullyLoaded && this.zapStatsLoaded) {
      sortZapsLink?.classList.remove('follows-sort-controls__link--disabled');
    }

    sortDateLink?.classList.toggle('active', this.currentSort === 'date');
    sortZapsLink?.classList.toggle('active', this.currentSort === 'zaps');
  }

  /**
   * Sort items by date (original order - newest first)
   */
  private sortByDate(): void {
    // Reset to original order (newest first based on Kind 3 tag order)
    this.allItemsWithProfiles.sort((a, b) => {
      const indexA = this.originalOrder.indexOf(a.pubkey);
      const indexB = this.originalOrder.indexOf(b.pubkey);
      return indexA - indexB;
    });
  }

  /**
   * Sort items by zap sum (highest first)
   */
  private sortByZaps(): void {
    this.allItemsWithProfiles.sort((a, b) => {
      const statsA = this.zapStatsService.getStats(a.pubkey);
      const statsB = this.zapStatsService.getStats(b.pubkey);

      const sumA = (statsA?.incomingSats || 0) + (statsA?.outgoingSats || 0);
      const sumB = (statsB?.incomingSats || 0) + (statsB?.outgoingSats || 0);

      return sumB - sumA; // Highest first
    });
  }

  /**
   * Render article notification label if user is subscribed
   */
  private renderArticleNotifLabel(pubkey: string): string {
    const articleNotifService = ArticleNotificationService.getInstance();
    if (articleNotifService.isSubscribed(pubkey)) {
      return '<span class="article-notif-label">(Article alerts)</span>';
    }
    return '';
  }
}
