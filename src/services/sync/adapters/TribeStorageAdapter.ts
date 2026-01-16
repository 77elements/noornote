/**
 * @adapter TribeStorageAdapter
 * @purpose Storage adapter for tribe lists (public + private merged)
 * @used-by ListSyncManager
 *
 * Delegates to /src/lists/tribes.ts for actual operations.
 */

import { BaseListStorageAdapter } from './BaseListStorageAdapter';
import type { FetchFromRelaysResult } from '../ListStorageAdapter';
import { SystemLogger } from '../../../components/system/SystemLogger';
import { StorageKeys, type StorageKey } from '../../PerAccountLocalStorage';
import { EventBus } from '../../EventBus';

// Import from consolidated tribes.ts
import * as tribes from '../../../lists/tribes';
import type { TribeMember } from '../../../lists/tribes';

// Re-export TribeMember type for consumers
export type { TribeMember };

export class TribeStorageAdapter extends BaseListStorageAdapter<TribeMember> {
  private logger = SystemLogger.getInstance();
  private eventBus: EventBus;

  constructor() {
    super();
    this.eventBus = EventBus.getInstance();
  }

  /**
   * Override setBrowserItems to emit tribe:updated event
   */
  override setBrowserItems(items: TribeMember[]): void {
    super.setBrowserItems(items);
    this.eventBus.emit('tribe:updated');
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
   * File Storage - read from file
   */
  async getFileItems(): Promise<TribeMember[]> {
    try {
      return await tribes.getFileMembers();
    } catch (error) {
      this.logger.error('TribeStorageAdapter', `Failed to read from file: ${error}`);
      throw error;
    }
  }

  /**
   * File Storage - save to file
   */
  async setFileItems(_items: TribeMember[]): Promise<void> {
    try {
      await tribes.saveToFile();
    } catch (error) {
      this.logger.error('TribeStorageAdapter', `Failed to write to file: ${error}`);
      throw error;
    }
  }

  /**
   * Restore folder data from file to per-account storage
   */
  async restoreFolderDataFromFile(): Promise<void> {
    try {
      await tribes.restoreFromFile();
    } catch (error) {
      this.logger.error('TribeStorageAdapter', `Failed to restore folder data: ${error}`);
    }
  }

  /**
   * Relay Storage - fetch from relays
   */
  async fetchFromRelays(): Promise<FetchFromRelaysResult<TribeMember>> {
    try {
      return await tribes.fetchFromRelays();
    } catch (error) {
      this.logger.error('TribeStorageAdapter', `Failed to fetch from relays: ${error}`);
      throw error;
    }
  }

  /**
   * Relay Storage - publish to relays
   */
  async publishToRelays(_items: TribeMember[]): Promise<void> {
    try {
      await tribes.publishToRelays();
    } catch (error) {
      this.logger.error('TribeStorageAdapter', `Failed to publish to relays: ${error}`);
      throw error;
    }
  }
}
