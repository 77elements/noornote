/**
 * @adapter TribeStorageAdapter
 * @purpose Storage adapter for tribe lists (public + private merged)
 * @used-by ListSyncManager
 *
 * Storage Locations:
 * - Browser: localStorage key 'noornote_tribes_browser' (TribeMember[])
 * - File: ~/.noornote/{npub}/tribes.json
 * - Relays: kind:30000 (Follow Sets) events
 */

import { BaseListStorageAdapter } from './BaseListStorageAdapter';
import { TribeFileStorage, type TribeMember } from '../../storage/TribeFileStorage';
import type { FetchFromRelaysResult } from '../ListStorageAdapter';
import { TribeOrchestrator } from '../../orchestration/TribeOrchestrator';
import { AuthService } from '../../AuthService';
import { SystemLogger } from '../../../components/system/SystemLogger';
import { StorageKeys, type StorageKey } from '../../PerAccountLocalStorage';

export class TribeStorageAdapter extends BaseListStorageAdapter<TribeMember> {
  private fileStorage: TribeFileStorage;
  private tribeOrchestrator: TribeOrchestrator;
  private authService: AuthService;
  private logger = SystemLogger.getInstance();

  constructor() {
    super();
    this.fileStorage = TribeFileStorage.getInstance();
    this.tribeOrchestrator = TribeOrchestrator.getInstance();
    this.authService = AuthService.getInstance();
  }

  protected getBrowserStorageKey(): string {
    return 'noornote_tribes_browser';  // Legacy, for migration only
  }

  protected override getPerAccountStorageKey(): StorageKey {
    return StorageKeys.TRIBES;
  }

  protected getLogPrefix(): string {
    return 'TribeStorageAdapter';
  }

  /**
   * Get unique ID for tribe member (pubkey)
   */
  getItemId(item: TribeMember): string {
    return item.pubkey;
  }

  /**
   * File Storage (Persistent Local) - Asynchronous
   * Reads all tribe members from file with category info
   */
  async getFileItems(): Promise<TribeMember[]> {
    try {
      // Use getAllMembers() which properly reads the TribeSetData format
      // and extracts items with their category field
      return await this.fileStorage.getAllMembers();
    } catch (error) {
      this.logger.error('TribeStorageAdapter', `Failed to read from file storage: ${error}`);
      throw error;
    }
  }

  /**
   * File Storage (Persistent Local) - Asynchronous
   * Writes items to files using TribeSetData format with categories
   */
  async setFileItems(_items: TribeMember[]): Promise<void> {
    try {
      // Use orchestrator to save in TribeSetData format (with categories)
      await this.tribeOrchestrator.saveToFile();
    } catch (error) {
      this.logger.error('TribeStorageAdapter', `Failed to write to file storage: ${error}`);
      throw error;
    }
  }

  /**
   * Restore folder data from file to per-account storage
   * Uses getAllFolderData() to include BOTH public AND private member assignments
   */
  async restoreFolderDataFromFile(): Promise<void> {
    try {
      const folderData = await this.fileStorage.getAllFolderData();

      if (folderData.folders.length > 0) {
        this.perAccountStorage.set(StorageKeys.TRIBE_FOLDERS, folderData.folders);
      }
      if (folderData.folderAssignments.length > 0) {
        this.perAccountStorage.set(StorageKeys.TRIBE_MEMBER_ASSIGNMENTS, folderData.folderAssignments);
      }
      if (folderData.rootOrder.length > 0) {
        this.perAccountStorage.set(StorageKeys.TRIBE_ROOT_ORDER, folderData.rootOrder);
      }
    } catch (error) {
      this.logger.error('TribeStorageAdapter', `Failed to restore folder data: ${error}`);
    }
  }

  /**
   * Relay Storage (Remote) - Asynchronous
   * Fetches kind:30000 event, returns merged members with metadata
   * Returns FetchFromRelaysResult to support mixed-client private item handling
   */
  async fetchFromRelays(): Promise<FetchFromRelaysResult<TribeMember>> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        throw new Error('User not authenticated');
      }

      return await this.tribeOrchestrator.fetchTribesFromRelays(currentUser.pubkey);
    } catch (error) {
      this.logger.error('TribeStorageAdapter', `Failed to fetch from relays: ${error}`);
      throw error;
    }
  }

  /**
   * Relay Storage (Remote) - Asynchronous
   * Publishes kind:30000 events respecting isPrivate flag
   *
   * Strategy: Reads from browser (localStorage) directly, does NOT modify files.
   * Files are only written on explicit "Save to file" action by user.
   */
  async publishToRelays(_items: TribeMember[]): Promise<void> {
    console.log('[TribeStorageAdapter] publishToRelays START');
    try {
      // Publish via orchestrator (reads from browser localStorage)
      console.log('[TribeStorageAdapter] Calling orchestrator.publishToRelays()');
      await this.tribeOrchestrator.publishToRelays();
      console.log('[TribeStorageAdapter] publishToRelays SUCCESS');
    } catch (error) {
      console.error('[TribeStorageAdapter] publishToRelays ERROR:', error);
      this.logger.error('TribeStorageAdapter', `Failed to publish to relays: ${error}`);
      throw error;
    }
  }
}
