/**
 * @abstract BaseListSecondaryManager
 * @purpose Base class for list sidebar managers with common sync/infinite scroll logic
 * @used-by MuteListSecondaryManager, FollowListSecondaryManager, BookmarkSecondaryManager
 *
 * Provides:
 * - Common browser storage initialization
 * - Infinite scroll with batch loading
 * - Sync operations (4-button controls)
 * - Common UI helpers
 */

import { EventBus } from '../../../services/EventBus';
import { AuthService } from '../../../services/AuthService';
import { ToastService } from '../../../services/ToastService';
import { ListSyncManager } from '../../../services/sync/ListSyncManager';
import { SyncConfirmationModal } from '../../modals/SyncConfirmationModal';
import { InfiniteScroll } from '../../ui/InfiniteScroll';
import { switchTabWithContent } from '../../../helpers/TabsHelper';
import { renderListSyncButtons } from '../../../helpers/ListSyncButtonsHelper';

export abstract class BaseListSecondaryManager<TItem, TWithProfile> {
  protected eventBus: EventBus;
  protected authService: AuthService;
  protected listSyncManager: ListSyncManager<TItem>;
  protected containerElement: HTMLElement;
  protected isInitialized: boolean = false;

  // Infinite scroll / batch loading
  protected infiniteScroll: InfiniteScroll | null = null;
  protected allItemsWithProfiles: TWithProfile[] = [];
  protected currentOffset: number = 0;
  protected hasMore: boolean = true;
  protected isLoading: boolean = false;
  protected readonly BATCH_SIZE: number = 20;

  constructor(containerElement: HTMLElement, listSyncManager: ListSyncManager<TItem>) {
    this.containerElement = containerElement;
    this.eventBus = EventBus.getInstance();
    this.authService = AuthService.getInstance();
    this.listSyncManager = listSyncManager;

    this.setupEventListeners();
  }

  /**
   * Abstract methods - must be implemented by subclasses
   */

  /**
   * Get the event name for this list type (e.g., 'follow:updated')
   */
  protected abstract getEventName(): string;

  /**
   * Get the tab data attribute value (e.g., 'list-follows')
   */
  protected abstract getTabDataAttribute(): string;

  /**
   * Get the list container class name (e.g., 'follows-list')
   */
  protected abstract getListContainerClass(): string;

  /**
   * Get the list type for sync confirmation modal (e.g., 'Follows')
   */
  protected abstract getListType(): string;

  /**
   * Get display name for sync confirmation modal
   */
  protected abstract getDisplayNameForSync(item: TItem): string | Promise<string>;

  /**
   * Fetch all items with profiles (implementation-specific)
   */
  protected abstract getAllItemsWithProfiles(): Promise<TWithProfile[]>;

  /**
   * Render a batch of items (implementation-specific HTML)
   */
  protected abstract renderBatch(listElement: HTMLElement, batch: TWithProfile[]): void | Promise<void>;

  /**
   * Handle item removal (implementation-specific logic)
   */
  protected abstract handleRemoveItem(item: TWithProfile, itemElement: HTMLElement): Promise<void>;

  /**
   * Initialize browser storage (NO automatic restore from file!)
   * App starts with last state in browser (localStorage)
   * Files are ONLY restored on explicit user button click
   */
  protected async initializeBrowserStorage(): Promise<void> {
    // NO automatic operations - browser storage is the source of truth on startup
    this.isInitialized = true;
  }

  /**
   * Setup event listeners
   */
  protected setupEventListeners(): void {
    this.eventBus.on(this.getEventName(), () => {
      this.refreshListIfActive();
    });

    this.eventBus.on('user:logout', () => {
      this.refreshListIfActive();
      this.switchToSystemLogsTab();
    });

    // On user switch, clear cached data and refresh if active
    this.eventBus.on('user:login', () => {
      this.allItemsWithProfiles = [];
      this.currentOffset = 0;
      this.hasMore = true;
      this.isLoading = false;
      this.refreshListIfActive();
    });

    // Re-render when sync mode changes (Manual <-> Easy)
    this.eventBus.on('list-sync-mode:changed', () => {
      this.refreshListIfActive();
    });
  }

  /**
   * Refresh list if it's currently active
   */
  protected refreshListIfActive(): void {
    const listTab = this.containerElement.querySelector(`[data-tab-content="${this.getTabDataAttribute()}"]`);
    if (listTab && listTab.classList.contains('tab-content--active')) {
      this.renderListTab(listTab as HTMLElement).catch(err => {
        console.error(`Failed to refresh ${this.getListType()}:`, err);
      });
    }
  }

  /**
   * Switch to System Logs tab
   */
  protected switchToSystemLogsTab(): void {
    switchTabWithContent(this.containerElement, 'system-log');
  }

  /**
   * Handle load more (infinite scroll trigger)
   */
  protected async handleLoadMore(): Promise<void> {
    const list = this.containerElement.querySelector(`.${this.getListContainerClass()}`);
    if (!list || this.isLoading || !this.hasMore) return;

    await this.loadBatch(list as HTMLElement);
  }

  /**
   * Load next batch of items
   */
  protected async loadBatch(listElement: HTMLElement): Promise<void> {
    if (this.isLoading || !this.hasMore) return;

    this.isLoading = true;

    // Show loading indicator (only for subsequent batches)
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

      // Render batch
      await this.renderBatch(listElement, batch);

      // Update offset
      this.currentOffset += batch.length;

      // Check if there are more items
      if (this.currentOffset >= this.allItemsWithProfiles.length) {
        this.hasMore = false;
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
   * Render list tab content (common structure)
   */
  protected async renderListTab(container: HTMLElement): Promise<void> {
    // Initialize browser storage from file on first render
    await this.initializeBrowserStorage();

    // Clean up existing infinite scroll
    if (this.infiniteScroll) {
      this.infiniteScroll.destroy();
      this.infiniteScroll = null;
    }

    // Reset batch loading state
    this.allItemsWithProfiles = [];
    this.currentOffset = 0;
    this.hasMore = true;
    this.isLoading = false;

    try {
      const currentUser = this.authService.getCurrentUser();

      if (!currentUser) {
        container.innerHTML = `
          <div class="${this.getListContainerClass()}-empty-state">
            <p>Log in to see your ${this.getListType().toLowerCase()}</p>
          </div>
        `;
        return;
      }

      // Show loading state
      container.innerHTML = `
        <div class="${this.getListContainerClass()}-loading">
          Loading ${this.getListType().toLowerCase()}...
        </div>
      `;

      // Fetch all items with profiles (implementation-specific)
      const itemsWithProfiles = await this.getAllItemsWithProfiles();

      if (itemsWithProfiles.length === 0) {
        container.innerHTML = this.renderControlButtons() + `
          <div class="${this.getListContainerClass()}-empty-state">
            <p>No ${this.getListType().toLowerCase()} yet</p>
          </div>
        ` + this.renderControlButtons();
        this.bindSyncButtons(container);
        return;
      }

      // Store all items for batch loading
      this.allItemsWithProfiles = itemsWithProfiles;

      // Render container with controls and empty list
      container.innerHTML = `
        ${this.renderControlButtons()}
        <div class="${this.getListContainerClass()}"></div>
        ${this.renderControlButtons()}
      `;

      // Bind sync button handlers
      this.bindSyncButtons(container);

      const list = container.querySelector(`.${this.getListContainerClass()}`);
      if (!list) return;

      // Load first batch
      await this.loadBatch(list as HTMLElement);

      // Setup infinite scroll if there are more items
      if (this.hasMore) {
        this.infiniteScroll = new InfiniteScroll(() => this.handleLoadMore(), {
          loadingMessage: `Loading more ${this.getListType().toLowerCase()}...`
        });
        this.infiniteScroll.observe(list as HTMLElement);
      }
    } catch (error) {
      console.error(`Failed to render ${this.getListType()}:`, error);
      container.innerHTML = `
        <div class="${this.getListContainerClass()}-empty-state">
          <p>Failed to load ${this.getListType().toLowerCase()}</p>
        </div>
      `;
    }
  }

  /**
   * Render control buttons based on sync mode (Manual vs Easy)
   */
  protected renderControlButtons(): string {
    return renderListSyncButtons();
  }

  /**
   * Bind sync button handlers
   */
  protected bindSyncButtons(container: HTMLElement): void {
    // Sync from Relays buttons
    container.querySelectorAll('.sync-from-relays-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        await this.handleSyncFromRelays(container);
      });
    });

    // Sync to Relays buttons
    container.querySelectorAll('.sync-to-relays-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        await this.handleSyncToRelays();
      });
    });

    // Save to File buttons
    container.querySelectorAll('.save-to-file-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        await this.handleSaveToFile();
      });
    });

    // Restore from File buttons
    container.querySelectorAll('.restore-from-file-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        await this.handleRestoreFromFile(container);
      });
    });
  }

  /**
   * Handle Sync from Relays (Relay → Browser)
   */
  protected async handleSyncFromRelays(container: HTMLElement): Promise<void> {
    try {
      ToastService.show('Fetching from relays...', 'info');

      const result = await this.listSyncManager.syncFromRelays();

      if (result.requiresConfirmation) {
        // Browser has MORE items than relay → Show confirmation modal
        const modal = new SyncConfirmationModal({
          listType: this.getListType(),
          added: result.diff.added,
          removed: result.diff.removed,
          getDisplayName: this.getDisplayNameForSync.bind(this),
          onKeep: async () => {
            await this.listSyncManager.applySyncFromRelays('merge', result.relayItems, result.relayContentWasEmpty);
            ToastService.show(`Merged ${result.diff.added.length} new ${this.getListType().toLowerCase()} (kept ${result.diff.removed.length} local ${this.getListType().toLowerCase()})`, 'success');
            await this.renderListTab(container);
          },
          onDelete: async () => {
            await this.listSyncManager.applySyncFromRelays('overwrite', result.relayItems, result.relayContentWasEmpty);
            ToastService.show(`Synced from relays (added ${result.diff.added.length}, removed ${result.diff.removed.length})`, 'success');
            await this.renderListTab(container);
          }
        });

        await modal.show();
      } else {
        // Browser has LESS/EQUAL items → Auto-merge
        await this.listSyncManager.applySyncFromRelays('merge', result.relayItems, result.relayContentWasEmpty);
        ToastService.show(`Synced ${result.diff.added.length} new ${this.getListType().toLowerCase()}${result.diff.added.length !== 1 ? 's' : ''} from relays`, 'success');
        await this.renderListTab(container);
      }
    } catch (error) {
      console.error('Failed to sync from relays:', error);
      ToastService.show('Failed to sync from relays', 'error');
    }
  }

  /**
   * Handle Sync to Relays (Browser → Relay)
   */
  protected async handleSyncToRelays(): Promise<void> {
    try {
      ToastService.show('Publishing to relays...', 'info');
      await this.listSyncManager.syncToRelays();
      ToastService.show(`${this.getListType()} published successfully`, 'success');
    } catch (error) {
      console.error('Failed to publish to relays:', error);
      ToastService.show('Failed to publish to relays', 'error');
    }
  }

  /**
   * Handle Save to File (Browser → File)
   * - Tauri: Saves to ~/.noornote/*.json
   * - Browser: Downloads as JSON file
   */
  protected async handleSaveToFile(): Promise<void> {
    try {
      ToastService.show('Saving...', 'info');
      await this.listSyncManager.saveToFile(this.getListType());
      ToastService.show('Saved successfully', 'success');
    } catch (error) {
      console.error('Failed to save to file:', error);
      ToastService.show('Failed to save', 'error');
    }
  }

  /**
   * Handle Restore from File (File → Browser)
   * - Tauri: Reads from ~/.noornote/*.json
   * - Browser: Opens file picker dialog
   */
  protected async handleRestoreFromFile(container: HTMLElement): Promise<void> {
    try {
      ToastService.show('Restoring...', 'info');
      const success = await this.listSyncManager.restoreFromFile();

      if (success) {
        ToastService.show('Restored successfully', 'success');
        await this.renderListTab(container);
      } else {
        ToastService.show('Restore cancelled or failed', 'warning');
      }
    } catch (error) {
      console.error('Failed to restore from file:', error);
      ToastService.show('Failed to restore', 'error');
    }
  }

  /**
   * Escape HTML
   */
  protected escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    if (this.infiniteScroll) {
      this.infiniteScroll.destroy();
      this.infiniteScroll = null;
    }
    // EventBus listeners are cleaned up automatically
  }
}
