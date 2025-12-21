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
   * (Tribes don't have the same complex folder structure as bookmarks,
   *  but we keep this for consistency with the adapter interface)
   */
  async restoreFolderDataFromFile(): Promise<void> {
    try {
      // For tribes, we might need to restore tribe folders later
      // For now, this is a placeholder
      this.logger.info('TribeStorageAdapter', 'Folder data restoration not yet implemented for tribes');
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
   * Strategy: Same as setFileItems - uses isPrivate flag from browser items,
   * falls back to existing file location for items without explicit flag.
   */
  async publishToRelays(items: TribeMember[]): Promise<void> {
    try {
      // First, save to files using the same logic as setFileItems
      await this.setFileItems(items);

      // Then publish via orchestrator (reads from files)
      await this.tribeOrchestrator.publishToRelays();
    } catch (error) {
      this.logger.error('TribeStorageAdapter', `Failed to publish to relays: ${error}`);
      throw error;
    }
  }
}
