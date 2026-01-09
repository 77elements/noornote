/**
 * @orchestrator FollowListOrchestrator
 * @purpose Manages follow lists (kind:3) with NIP-51 private follow support
 * @used-by UserService, SettingsView
 *
 * REFACTORED: Now uses GenericListOrchestrator with config-driven approach
 */

import type { FollowItem } from '../storage/FollowFileStorage';
import type { FetchFromRelaysResult } from '../sync/ListStorageAdapter';
import { GenericListOrchestrator } from './GenericListOrchestrator';
import { followListConfig, createFollowFileStorageWrapper } from './configs/FollowListConfig';
import { AppState } from '../AppState';

// Re-export FollowItem for external use
export type { FollowItem };

export class FollowListOrchestrator extends GenericListOrchestrator<FollowItem> {
  private static instance: FollowListOrchestrator;
  private featureFlagKey = 'noornote_nip51_private_follows_enabled';
  private migrationFlagKey = 'noornote_follows_file_storage_migrated';

  // Sync state tracking (Race Condition Prevention)
  private isSyncing: boolean = false;
  private lastSyncedFollowCount: number = 0;
  private lastSyncTimestamp: number = 0;

  private constructor() {
    super('FollowListOrchestrator', followListConfig, createFollowFileStorageWrapper());
  }

  public static getInstance(): FollowListOrchestrator {
    if (!FollowListOrchestrator.instance) {
      FollowListOrchestrator.instance = new FollowListOrchestrator();
    }
    return FollowListOrchestrator.instance;
  }

  public isPrivateFollowsEnabled(): boolean {
    return localStorage.getItem(this.featureFlagKey) === 'true';
  }

  public setPrivateFollowsEnabled(enabled: boolean): void {
    localStorage.setItem(this.featureFlagKey, enabled.toString());
  }

  private isMigrated(): boolean {
    return localStorage.getItem(this.migrationFlagKey) === 'true';
  }

  private setMigrated(): void {
    localStorage.setItem(this.migrationFlagKey, 'true');
  }

  public isSyncInProgress(): boolean {
    return this.isSyncing;
  }

  public getLastSyncedFollowCount(): number {
    return this.lastSyncedFollowCount;
  }

  public getLastSyncTimestamp(): number {
    return this.lastSyncTimestamp;
  }

  /**
   * Get combined follow list (respects NIP-51 feature flag)
   * FILE-BASED STORAGE: Reads from local files
   *
   * @param pubkey - User pubkey
   * @param isInitialSync - If true, marks as syncing and updates AppState
   */
  public async getCombinedFollowList(pubkey: string, isInitialSync: boolean = false): Promise<FollowItem[]> {
    // Mark as syncing if this is initial sync
    if (isInitialSync) {
      this.isSyncing = true;
      this.systemLogger.info('FollowListOrchestrator', 'Starting initial sync...');

      // Update AppState: syncing
      AppState.getInstance().setState('user', {
        syncStatus: { status: 'syncing' }
      });
    }

    try {
      // Check if we've migrated to file storage
      const migrated = this.isMigrated();

      if (!migrated) {
        // MIGRATION: Fetch from relays one last time
        this.systemLogger.info('FollowListOrchestrator', 'First run detected - migrating from relay to file storage...');
        await this.migrateFromRelaysToFiles(pubkey);
        this.setMigrated();
      }

      // Read from local files via GenericListOrchestrator
      const allFollows = await this.fileStorage.getAllItems();

      // Update sync state if this was initial sync
      if (isInitialSync) {
        this.isSyncing = false;
        this.lastSyncedFollowCount = allFollows.length;
        this.lastSyncTimestamp = Date.now();
        this.systemLogger.info('FollowListOrchestrator',
          `Initial sync completed: ${allFollows.length} follows loaded from files`
        );

        // Update AppState: synced
        AppState.getInstance().setState('user', {
          syncStatus: {
            status: 'synced',
            count: allFollows.length,
            timestamp: this.lastSyncTimestamp
          }
        });
      }

      return allFollows;
    } catch (error) {
      // Mark sync as failed
      if (isInitialSync) {
        this.isSyncing = false;
        this.systemLogger.error('FollowListOrchestrator', `Initial sync failed: ${error}`);

        // Update AppState: error
        AppState.getInstance().setState('user', {
          syncStatus: {
            status: 'error',
            error: String(error)
          }
        });
      }

      this.systemLogger.error('FollowListOrchestrator', `Failed to fetch follow list: ${error}`);
      return [];
    }
  }

  /**
   * Migrate from relay-based to file-based storage
   * Fetches from relays, extracts NIP-02 metadata, writes to files
   */
  private async migrateFromRelaysToFiles(pubkey: string): Promise<void> {
    const relays = this.getBootstrapRelays();
    this.systemLogger.info('FollowListOrchestrator', `Migrating from relays (${relays.length} relays)...`);

    try {
      // Fetch both kind:3 (public) and kind:30000 (private) events
      const [kind3Events, kind30000Events] = await Promise.all([
        this.transport.fetch(relays, [{
          authors: [pubkey],
          kinds: [3],
          limit: 1
        }], 5000),
        this.isPrivateFollowsEnabled()
          ? this.transport.fetch(relays, [{
              authors: [pubkey],
              kinds: [30000],
              '#d': ['private-follows'],
              limit: 1
            }], 5000)
          : Promise.resolve([])
      ]);

      // Extract public follows with NIP-02 metadata
      let publicFollows: FollowItem[] = [];
      if (kind3Events.length > 0) {
        const followEvent = kind3Events[0];

        publicFollows = followEvent.tags
          .filter(tag => tag[0] === 'p' && tag[1])
          .map(tag => ({
            pubkey: tag[1],
            relay: tag[2] || undefined,
            petname: tag[3] || undefined,
            addedAt: followEvent.created_at
          }));
      }

      // Extract private follows from kind:30000
      let privateFollows: FollowItem[] = [];
      if (this.isPrivateFollowsEnabled() && kind30000Events.length > 0) {
        const privateListEvent = kind30000Events[0];

        try {
          const { parsePrivateFollowListEvent } = await import('../../helpers/parsePrivateFollowListEvent');
          const privatePubkeys = await parsePrivateFollowListEvent(privateListEvent, pubkey);
          privateFollows = privatePubkeys.map(pk => ({
            pubkey: pk,
            addedAt: privateListEvent.created_at,
            isPrivate: true
          }));
        } catch (error) {
          this.systemLogger.error('FollowListOrchestrator', `Failed to parse private follow list: ${error}`);
        }
      }

      // Write to files
      await this.fileStorage.writePublic({
        items: publicFollows,
        lastModified: Math.floor(Date.now() / 1000)
      });

      await this.fileStorage.writePrivate({
        items: privateFollows,
        lastModified: Math.floor(Date.now() / 1000)
      });

      this.systemLogger.info('FollowListOrchestrator',
        `Migration complete: ${publicFollows.length} public, ${privateFollows.length} private follows written to files`
      );
    } catch (error) {
      this.systemLogger.error('FollowListOrchestrator', `Migration failed: ${error}`);
      throw error;
    }
  }

  /**
   * Fetch follows from relays (read-only, no local changes)
   */
  public async fetchFollowsFromRelays(pubkey: string): Promise<FetchFromRelaysResult<FollowItem>> {
    return this.fetchFromRelays(pubkey);
  }

  /**
   * Add follow (browser storage only)
   */
  public async addFollow(pubkey: string, isPrivate: boolean): Promise<void> {
    await this.addItem({
      pubkey,
      addedAt: Math.floor(Date.now() / 1000),
      isPrivate
    });
  }

  /**
   * Remove follow (browser storage only)
   */
  public async removeFollow(pubkey: string): Promise<void> {
    await this.removeItem(pubkey);
  }

  /**
   * Get all follows with their status (public/private/both)
   */
  public async getAllFollowsWithStatus(): Promise<Map<string, { public: boolean; private: boolean }>> {
    return this.getAllItemsWithStatus();
  }

  /**
   * Publish follow list (legacy signature for backward compatibility)
   *
   * @param publicFollows - Follows to store in kind:3 tags (visible)
   * @param privateFollows - Follows to store in kind:30000 content (encrypted)
   * @param skipValidation - Skip validation (use with caution)
   */
  public async publishFollowList(
    publicFollows: FollowItem[],
    privateFollows: FollowItem[],
    skipValidation: boolean = false
  ): Promise<boolean> {
    const currentUser = this.authService.getCurrentUser();

    if (!currentUser) {
      throw new Error('User not authenticated');
    }

    // Block publishing during initial sync
    if (this.isSyncing) {
      throw new Error('Still syncing follow list. Please wait.');
    }

    // Validate dramatic changes (unless explicitly skipped)
    if (!skipValidation && this.lastSyncedFollowCount > 0) {
      const newTotalCount = publicFollows.length + privateFollows.length;
      const previousCount = this.lastSyncedFollowCount;

      const percentageChange = ((newTotalCount - previousCount) / previousCount) * 100;
      const isDramaticDrop = percentageChange < -50 || (previousCount > 10 && newTotalCount <= 5);

      if (isDramaticDrop) {
        this.systemLogger.warn('FollowListOrchestrator',
          `Suspicious follow count change detected: ${previousCount} → ${newTotalCount} (${percentageChange.toFixed(1)}%)`
        );
        throw new Error(
          `Suspicious follow count change: ${previousCount} → ${newTotalCount}. ` +
          `This might indicate a sync issue. Please refresh and try again.`
        );
      }
    }

    try {
      // 1. Write to local files FIRST
      await this.fileStorage.writePublic({
        items: publicFollows,
        lastModified: Math.floor(Date.now() / 1000)
      });

      await this.fileStorage.writePrivate({
        items: privateFollows,
        lastModified: Math.floor(Date.now() / 1000)
      });

      this.systemLogger.info('FollowListOrchestrator',
        `Wrote to files: ${publicFollows.length} public, ${privateFollows.length} private`
      );

      // 2. Publish to relays via GenericListOrchestrator
      // First, set browser items to match what we're publishing
      const allItems = [
        ...publicFollows.map(f => ({ ...f, isPrivate: false })),
        ...privateFollows.map(f => ({ ...f, isPrivate: true }))
      ];
      this.setBrowserItems(allItems);

      // Publish via parent class
      await super.publishToRelays();

      // Update sync state after successful publish
      this.lastSyncedFollowCount = publicFollows.length + privateFollows.length;
      this.lastSyncTimestamp = Date.now();

      return true;
    } catch (error) {
      this.systemLogger.error('FollowListOrchestrator', `Failed to publish follow list: ${error}`);
      throw error;
    }
  }

  /**
   * Migrate legacy kind:3 encrypted content → kind:30000
   */
  public async migrateLegacyPrivateFollows(pubkey: string): Promise<boolean> {
    try {
      const relays = this.getBootstrapRelays();

      // Fetch kind:3 event
      const kind3Events = await this.transport.fetch(relays, [{
        authors: [pubkey],
        kinds: [3],
        limit: 1
      }], 5000);

      if (kind3Events.length === 0) {
        this.systemLogger.warn('FollowListOrchestrator', 'No kind:3 event found for migration');
        return false;
      }

      const kind3Event = kind3Events[0];

      // Check if content field contains encrypted data
      if (!kind3Event.content || kind3Event.content.trim() === '') {
        this.systemLogger.info('FollowListOrchestrator', 'No legacy encrypted content found, skipping migration');
        return false;
      }

      // Extract public follows from tags
      const publicFollows: FollowItem[] = kind3Event.tags
        .filter(tag => tag[0] === 'p' && tag[1])
        .map(tag => ({
          pubkey: tag[1],
          relay: tag[2] || undefined,
          petname: tag[3] || undefined,
          addedAt: kind3Event.created_at
        }));

      // Decrypt legacy private follows from content
      let legacyPrivatePubkeys: string[] = [];
      try {
        const { decryptPrivateFollows } = await import('../../helpers/decryptPrivateFollows');
        legacyPrivatePubkeys = await decryptPrivateFollows(kind3Event.content, pubkey);
      } catch (error) {
        this.systemLogger.error('FollowListOrchestrator', `Failed to decrypt legacy private follows: ${error}`);
        return false;
      }

      if (legacyPrivatePubkeys.length === 0) {
        this.systemLogger.info('FollowListOrchestrator', 'No legacy private follows found');
        return false;
      }

      const legacyPrivateFollows: FollowItem[] = legacyPrivatePubkeys.map(pk => ({
        pubkey: pk,
        addedAt: kind3Event.created_at,
        isPrivate: true
      }));

      // Publish new structure (skip validation)
      await this.publishFollowList(publicFollows, legacyPrivateFollows, true);

      this.systemLogger.info('FollowListOrchestrator',
        `Migrated ${legacyPrivateFollows.length} legacy private follows to kind:30000`
      );

      return true;
    } catch (error) {
      this.systemLogger.error('FollowListOrchestrator', `Legacy migration failed: ${error}`);
      throw error;
    }
  }

  /**
   * Migrate all follows to private
   */
  public async migrateToPrivate(pubkey: string): Promise<boolean> {
    return this.migrateFollowsPrivacy(pubkey, true);
  }

  /**
   * Migrate all follows to public
   */
  public async migrateToPublic(pubkey: string): Promise<boolean> {
    return this.migrateFollowsPrivacy(pubkey, false);
  }

  /**
   * Internal helper: migrate all follows to specified privacy setting
   */
  private async migrateFollowsPrivacy(pubkey: string, toPrivate: boolean): Promise<boolean> {
    const followList = await this.getCombinedFollowList(pubkey);

    if (followList.length === 0) {
      throw new Error('No follows to migrate');
    }

    const migratedFollows = followList.map(f => ({ ...f, isPrivate: toPrivate }));
    const publicFollows = toPrivate ? [] : migratedFollows;
    const privateFollows = toPrivate ? migratedFollows : [];

    await this.publishFollowList(publicFollows, privateFollows, true);

    const visibility = toPrivate ? 'private' : 'public';
    this.systemLogger.info('FollowListOrchestrator',
      `Migrated ${followList.length} follows to ${visibility}`
    );

    return true;
  }
}
