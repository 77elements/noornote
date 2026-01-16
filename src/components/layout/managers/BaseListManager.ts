/**
 * @abstract BaseListManager
 * @purpose Base class for list sidebar managers with common sync/infinite scroll logic
 * @used-by MuteListManager, FollowListManager, BookmarkManager
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
import { renderListSyncButtons, bindSwitchSyncModeLink } from '../../../helpers/ListSyncMode';

export abstract class BaseListManager<TItem, TWithProfile> {
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
  protected abstract getEventName(): string;
  protected abstract getTabDataAttribute(): string;
  protected abstract getListContainerClass(): string;
  protected abstract getListType(): string;
  protected abstract getDisplayNameForSync(item: TItem): string | Promise<string>;
  protected abstract getAllItemsWithProfiles(): Promise<TWithProfile[]>;
  protected abstract renderBatch(listElement: HTMLElement, batch: TWithProfile[]): void | Promise<void>;
  protected abstract handleRemoveItem(item: TWithProfile, itemElement: HTMLElement): Promise<void>;

  /**
   * Initialize browser storage (NO automatic restore from file!)
   * App starts with last state in browser (localStorage)
   * Files are ONLY restored on explicit user button click
   */
  protected async initializeBrowserStorage(): Promise<void> {
    this.isInitialized = true;
  }

  /**
   * Reset batch loading state
   */
  private resetBatchState(): void {
    this.allItemsWithProfiles = [];
    this.currentOffset = 0;
    this.hasMore = true;
    this.isLoading = false;
  }

  /**
   * Setup event listeners
   */
  protected setupEventListeners(): void {
    this.eventBus.on(this.getEventName(), () => this.refreshListIfActive());
    this.eventBus.on('user:logout', () => {
      this.refreshListIfActive();
      this.switchToSystemLogsTab();
    });
    this.eventBus.on('user:login', () => {
      this.resetBatchState();
      this.refreshListIfActive();
    });
    this.eventBus.on('list-sync-mode:changed', () => this.refreshListIfActive());
  }

  /**
   * Refresh list if it's currently active
   */
  protected refreshListIfActive(): void {
    const listTab = this.containerElement.querySelector(`[data-tab-content="${this.getTabDataAttribute()}"]`);
    if (listTab?.classList.contains('tab-content--active')) {
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

    if (this.currentOffset > 0) {
      this.infiniteScroll?.showLoading();
    }

    try {
      const batch = this.allItemsWithProfiles.slice(
        this.currentOffset,
        this.currentOffset + this.BATCH_SIZE
      );

      if (batch.length === 0) {
        this.hasMore = false;
        return;
      }

      await this.renderBatch(listElement, batch);
      this.currentOffset += batch.length;

      if (this.currentOffset >= this.allItemsWithProfiles.length) {
        this.hasMore = false;
      }
    } catch (error) {
      console.error('Failed to load batch:', error);
    } finally {
      this.isLoading = false;
      this.infiniteScroll?.hideLoading();
    }
  }

  /**
   * Render list tab content (common structure)
   */
  protected async renderListTab(container: HTMLElement): Promise<void> {
    await this.initializeBrowserStorage();

    if (this.infiniteScroll) {
      this.infiniteScroll.destroy();
      this.infiniteScroll = null;
    }

    this.resetBatchState();

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

      container.innerHTML = `
        <div class="${this.getListContainerClass()}-loading">
          Loading ${this.getListType().toLowerCase()}...
        </div>
      `;

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

      this.allItemsWithProfiles = itemsWithProfiles;

      container.innerHTML = `
        ${this.renderControlButtons()}
        <div class="${this.getListContainerClass()}"></div>
        ${this.renderControlButtons()}
      `;

      this.bindSyncButtons(container);

      const list = container.querySelector(`.${this.getListContainerClass()}`);
      if (!list) return;

      await this.loadBatch(list as HTMLElement);

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
   * Bind a sync button by class name
   */
  private bindButton(container: HTMLElement, className: string, handler: () => Promise<void>): void {
    container.querySelectorAll(`.${className}`).forEach(btn => {
      btn.addEventListener('click', handler);
    });
  }

  /**
   * Bind sync button handlers
   */
  protected bindSyncButtons(container: HTMLElement): void {
    this.bindButton(container, 'sync-from-relays-btn', () => this.handleSyncFromRelays(container));
    this.bindButton(container, 'sync-to-relays-btn', () => this.handleSyncToRelays());
    this.bindButton(container, 'save-to-file-btn', () => this.handleSaveToFile());
    this.bindButton(container, 'restore-from-file-btn', () => this.handleRestoreFromFile(container));
    bindSwitchSyncModeLink(container, () => this.renderListTab(container));
  }

  /**
   * Handle Sync from Relays (Relay → Browser)
   */
  protected async handleSyncFromRelays(container: HTMLElement): Promise<void> {
    try {
      ToastService.show('Fetching from relays...', 'info');

      const result = await this.listSyncManager.syncFromRelays();

      if (result.requiresConfirmation) {
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
   */
  protected async handleRestoreFromFile(container: HTMLElement): Promise<void> {
    try {
      ToastService.show('Reading from file...', 'info');
      const result = await this.listSyncManager.syncFromFile();

      if (result.requiresConfirmation) {
        const modal = new SyncConfirmationModal({
          listType: `${this.getListType()} (File)`,
          added: result.diff.added,
          removed: result.diff.removed,
          getDisplayName: this.getDisplayNameForSync.bind(this),
          onKeep: async () => {
            await this.listSyncManager.applySyncFromFile('merge', result.fileItems);
            ToastService.show(`Merged ${result.diff.added.length} from file (kept ${result.diff.removed.length} local)`, 'success');
            await this.renderListTab(container);
          },
          onDelete: async () => {
            await this.listSyncManager.applySyncFromFile('overwrite', result.fileItems);
            ToastService.show(`Restored from file (added ${result.diff.added.length}, removed ${result.diff.removed.length})`, 'success');
            await this.renderListTab(container);
          }
        });
        modal.show();
      } else if (result.diff.added.length > 0) {
        await this.listSyncManager.applySyncFromFile('overwrite', result.fileItems);
        ToastService.show(`Restored ${result.diff.added.length} item${result.diff.added.length > 1 ? 's' : ''} from file`, 'success');
        await this.renderListTab(container);
      } else {
        ToastService.show('File is identical to current list', 'info');
      }
    } catch (error) {
      console.error('Failed to restore from file:', error);
      ToastService.show(`Failed to restore: ${error}`, 'error');
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
  }
}
