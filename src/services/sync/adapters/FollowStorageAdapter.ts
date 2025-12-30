/**
 * @adapter FollowStorageAdapter
 * @purpose Storage adapter for follow lists (public + private merged)
 * @used-by ListSyncManager
 *
 * Storage Locations:
 * - Browser: localStorage key 'noornote_follows_browser' (FollowItem[])
 * - File: ~/.noornote/follows-public.json + follows-private.json
 * - Relays: kind:3 (public) + kind:30000 (private) events
 */

import { BaseListStorageAdapter } from './BaseListStorageAdapter';
import { FollowFileStorage, type FollowItem } from '../../storage/FollowFileStorage';
import type { FetchFromRelaysResult } from '../ListStorageAdapter';
import { FollowListOrchestrator } from '../../orchestration/FollowListOrchestrator';
import { AuthService } from '../../AuthService';
import { StorageKeys, type StorageKey } from '../../PerAccountLocalStorage';
import { EventBus } from '../../EventBus';

export class FollowStorageAdapter extends BaseListStorageAdapter<FollowItem> {
  private fileStorage: FollowFileStorage;
  private followOrchestrator: FollowListOrchestrator;
  private authService: AuthService;
  private eventBus: EventBus;

  constructor() {
    super();
    this.fileStorage = FollowFileStorage.getInstance();
    this.followOrchestrator = FollowListOrchestrator.getInstance();
    this.authService = AuthService.getInstance();
    this.eventBus = EventBus.getInstance();
  }

  protected getBrowserStorageKey(): string {
    return 'noornote_follows_browser';  // Legacy, for migration only
  }

  protected override getPerAccountStorageKey(): StorageKey {
    return StorageKeys.FOLLOWS;
  }

  protected getLogPrefix(): string {
    return 'FollowStorageAdapter';
  }

  /**
   * Get unique ID for follow item (pubkey)
   */
  getItemId(item: FollowItem): string {
    return item.pubkey;
  }

  /**
   * File Storage (Persistent Local) - Asynchronous
   * Reads both public + private, returns merged list
   */
  async getFileItems(): Promise<FollowItem[]> {
    try {
      return await this.fileStorage.getAllFollows();
    } catch (error) {
      console.error('[FollowStorageAdapter] Failed to read from file storage:', error);
      throw error;
    }
  }

  /**
   * File Storage (Persistent Local) - Asynchronous
   * Writes items to files, overwriting existing data
   *
   * Strategy: Simply split by isPrivate flag and overwrite files
   * - isPrivate=true → private file
   * - isPrivate=false/undefined → public file (default)
   */
  async setFileItems(items: FollowItem[]): Promise<void> {
    try {
      // Split by privacy flag
      const publicItems = items.filter(item => !item.isPrivate);
      const privateItems = items.filter(item => item.isPrivate);

      const timestamp = this.getCurrentTimestamp();

      // Overwrite files
      await this.fileStorage.writePublic({
        items: publicItems,
        lastModified: timestamp
      });

      await this.fileStorage.writePrivate({
        items: privateItems,
        lastModified: timestamp
      });
    } catch (error) {
      console.error('[FollowStorageAdapter] Failed to write to file storage:', error);
      throw error;
    }
  }

  /**
   * Relay Storage (Remote) - Asynchronous
   * Fetches kind:3 event, returns merged follows with metadata
   * Returns FetchFromRelaysResult to support mixed-client private item handling
   */
  async fetchFromRelays(): Promise<FetchFromRelaysResult<FollowItem>> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        throw new Error('User not authenticated');
      }

      return await this.followOrchestrator.fetchFollowsFromRelays(currentUser.pubkey);
    } catch (error) {
      console.error('[FollowStorageAdapter] Failed to fetch from relays:', error);
      throw error;
    }
  }

  /**
   * Relay Storage (Remote) - Asynchronous
   * Publishes kind:3 + kind:30000 events respecting isPrivate flag
   *
   * Strategy: Same as setFileItems - uses isPrivate flag from browser items,
   * falls back to existing file location for items without explicit flag.
   */
  async publishToRelays(items: FollowItem[]): Promise<void> {
    try {
      // First, save to files using the same logic as setFileItems
      await this.setFileItems(items);

      // Then publish via orchestrator (reads from files)
      await this.followOrchestrator.publishToRelays();
    } catch (error) {
      console.error('[FollowStorageAdapter] Failed to publish to relays:', error);
      throw error;
    }
  }

  /**
   * Override setBrowserItems to emit follow:updated event
   * This ensures ProfileRecognitionService gets notified of changes from:
   * - Sync from relays
   * - Restore from file
   * - Manual sync operations
   */
  override setBrowserItems(items: FollowItem[]): void {
    super.setBrowserItems(items);
    this.eventBus.emit('follow:updated');
  }
}
