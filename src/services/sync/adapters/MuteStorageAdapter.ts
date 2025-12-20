/**
 * @adapter MuteStorageAdapter
 * @purpose Storage adapter for mute lists (public + private merged)
 * @used-by ListSyncManager
 *
 * REFACTORED: Now uses unified MuteItem[] format from MuteOrchestrator
 *
 * Storage Locations:
 * - Browser: localStorage key 'noornote_mutes_browser_v2' (MuteItem[])
 * - File: ~/.noornote/mutes-public.json + mutes-private.json
 * - Relays: kind:10000 event (public in tags, private in content)
 */

import { BaseListStorageAdapter } from './BaseListStorageAdapter';
import { MuteFileStorage } from '../../storage/MuteFileStorage';
import type { FetchFromRelaysResult } from '../ListStorageAdapter';
import { MuteOrchestrator } from '../../orchestration/MuteOrchestrator';
import type { MuteItem } from '../../../types/BaseListItem';
import { migrateMuteStorage, needsMuteMigration, cleanupOldMuteStorage } from '../../../types/BaseListItem';
import { StorageKeys, type StorageKey } from '../../PerAccountLocalStorage';

// Legacy browser storage key (for migration only)
const BROWSER_STORAGE_KEY = 'noornote_mutes_browser_v2';

export class MuteStorageAdapter extends BaseListStorageAdapter<string> {
  private fileStorage: MuteFileStorage;
  private muteOrchestrator: MuteOrchestrator;

  constructor() {
    super();
    this.fileStorage = MuteFileStorage.getInstance();
    this.muteOrchestrator = MuteOrchestrator.getInstance();

    // Run migration if needed
    this.checkAndRunMigration();
  }

  /**
   * Run one-time migration from old 4-key format to new unified format
   */
  private checkAndRunMigration(): void {
    if (needsMuteMigration()) {
      console.log('[MuteStorageAdapter] Running localStorage migration (4 keys → 1 key)...');

      const migratedItems = migrateMuteStorage();

      if (migratedItems.length > 0) {
        this.setBrowserMuteItems(migratedItems);
        cleanupOldMuteStorage();

        console.log('[MuteStorageAdapter] Migration complete:', migratedItems.length, 'items');
      }
    }
  }

  protected getBrowserStorageKey(): string {
    return BROWSER_STORAGE_KEY;  // Legacy, for migration only
  }

  protected override getPerAccountStorageKey(): StorageKey {
    return StorageKeys.MUTES;
  }

  protected getLogPrefix(): string {
    return 'MuteStorageAdapter';
  }

  /**
   * Get unique ID for mute item (pubkey itself)
   */
  getItemId(pubkey: string): string {
    return pubkey;
  }

  /**
   * Get MuteItems from per-account browser storage
   */
  private getBrowserMuteItems(): MuteItem[] {
    try {
      return this.perAccountStorage.get<MuteItem[]>(StorageKeys.MUTES, []);
    } catch {
      return [];
    }
  }

  /**
   * Set MuteItems in per-account browser storage
   */
  private setBrowserMuteItems(items: MuteItem[]): void {
    try {
      this.perAccountStorage.set(StorageKeys.MUTES, items);
    } catch (error) {
      console.error('[MuteStorageAdapter] Failed to write to browser storage:', error);
    }
  }

  /**
   * Browser Storage (Runtime) - Returns only USER mutes as string[]
   * Overrides BaseListStorageAdapter.getBrowserItems()
   *
   * Note: ListSyncManager expects string[] (user pubkeys), not MuteItem[]
   */
  override getBrowserItems(): string[] {
    const muteItems = this.getBrowserMuteItems();

    // Filter user mutes only (not threads)
    const userMutes = muteItems
      .filter(item => item.type === 'user')
      .map(item => item.id);

    return [...new Set(userMutes)]; // Deduplicate
  }

  /**
   * Browser Storage (Runtime) - Merges string[] with existing MuteItems
   * Overrides BaseListStorageAdapter.setBrowserItems()
   *
   * Note: This preserves existing threads while updating user mutes
   */
  override setBrowserItems(userPubkeys: string[]): void {
    const currentItems = this.getBrowserMuteItems();

    // Keep existing threads
    const threads = currentItems.filter(item => item.type === 'thread');

    // Convert user pubkeys to MuteItems (preserve isPrivate if exists)
    const existingUserMap = new Map(
      currentItems
        .filter(item => item.type === 'user')
        .map(item => [item.id, item])
    );

    const userItems: MuteItem[] = userPubkeys.map(pubkey => {
      const existing = existingUserMap.get(pubkey);
      return existing || {
        id: pubkey,
        type: 'user',
        addedAt: Math.floor(Date.now() / 1000)
      };
    });

    // Merge and write
    this.setBrowserMuteItems([...userItems, ...threads]);
  }

  /**
   * File Storage (Persistent Local) - Asynchronous
   * Reads both public + private, returns merged USER mutes only
   */
  async getFileItems(): Promise<string[]> {
    try {
      const [publicData, privateData] = await Promise.all([
        this.fileStorage.readPublic(),
        this.fileStorage.readPrivate()
      ]);

      // Merge and deduplicate users (threads are stored in files but not returned here)
      return [...new Set([...publicData.items, ...privateData.items])];
    } catch (error) {
      console.error('[MuteStorageAdapter] Failed to read from file storage:', error);
      throw error;
    }
  }

  /**
   * File Storage (Persistent Local) - Asynchronous
   * Writes ALL browser items (users + threads) respecting privacy flags
   *
   * Strategy:
   * 1. Read all MuteItems from browser storage
   * 2. Separate by type (user/thread) and privacy (public/private)
   * 3. Write to respective files
   */
  async setFileItems(_items: string[]): Promise<void> {
    try {
      // Read ALL browser items directly (users + threads)
      const browserItems = this.getBrowserMuteItems();

      // Separate by privacy
      const publicItems = browserItems.filter(item => !item.isPrivate);
      const privateItems = browserItems.filter(item => item.isPrivate);

      // Separate by type
      const publicUsers = publicItems.filter(item => item.type === 'user').map(item => item.id);
      const publicThreads = publicItems.filter(item => item.type === 'thread').map(item => item.id);

      const privateUsers = privateItems.filter(item => item.type === 'user').map(item => item.id);
      const privateThreads = privateItems.filter(item => item.type === 'thread').map(item => item.id);

      // Write to files (both users and threads)
      await this.fileStorage.writePublic({
        items: publicUsers,
        eventIds: publicThreads,
        lastModified: this.getCurrentTimestamp()
      });

      await this.fileStorage.writePrivate({
        items: privateUsers,
        eventIds: privateThreads,
        lastModified: this.getCurrentTimestamp()
      });

      console.log('[MuteStorageAdapter] Saved to files:', {
        public: { users: publicUsers.length, threads: publicThreads.length },
        private: { users: privateUsers.length, threads: privateThreads.length }
      });
    } catch (error) {
      console.error('[MuteStorageAdapter] Failed to write to file storage:', error);
      throw error;
    }
  }

  /**
   * Relay Storage (Remote) - Asynchronous
   * Fetches kind:10000 event, returns merged public + private USER mutes
   * Returns FetchFromRelaysResult to support mixed-client private item handling
   */
  async fetchFromRelays(): Promise<FetchFromRelaysResult<string>> {
    try {
      return await this.muteOrchestrator.fetchMutesFromRelays();
    } catch (error) {
      console.error('[MuteStorageAdapter] Failed to fetch from relays:', error);
      throw error;
    }
  }

  /**
   * Relay Storage (Remote) - Asynchronous
   * Publishes kind:10000 event respecting browser private storage
   */
  async publishToRelays(items: string[]): Promise<void> {
    console.log('[MuteStorageAdapter] publishToRelays called with', items.length, 'items');
    try {
      // First, save to files using the same logic as setFileItems
      await this.setFileItems(items);

      // Then publish via orchestrator (reads from files)
      await this.muteOrchestrator.publishToRelays();
    } catch (error) {
      console.error('[MuteStorageAdapter] Failed to publish to relays:', error);
      throw error;
    }
  }
}
