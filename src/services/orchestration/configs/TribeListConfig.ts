/**
 * TribeListConfig - Configuration for tribe list management
 * Used by TribeOrchestrator via GenericListOrchestrator
 *
 * Tribes are curated lists of Nostr users (pubkeys) based on NIP-51 Follow Sets (kind:30000)
 */

import type { ListConfig, FileStorageWrapper } from '../../../types/ListConfig';
import type { TribeMember } from '../../storage/TribeFileStorage';
import { TribeFileStorage } from '../../storage/TribeFileStorage';
import { StorageKeys } from '../../PerAccountLocalStorage';

/**
 * File Storage Wrapper for Tribes
 */
class TribeFileStorageWrapper implements FileStorageWrapper<TribeMember> {
  private storage: TribeFileStorage;

  constructor() {
    this.storage = TribeFileStorage.getInstance();
  }

  async readPublic(): Promise<{ items: TribeMember[]; lastModified: number }> {
    return await this.storage.readPublic();
  }

  async writePublic(data: { items: TribeMember[]; lastModified: number }): Promise<void> {
    await this.storage.writePublic(data);
  }

  async readPrivate(): Promise<{ items: TribeMember[]; lastModified: number }> {
    return await this.storage.readPrivate();
  }

  async writePrivate(data: { items: TribeMember[]; lastModified: number }): Promise<void> {
    await this.storage.writePrivate(data);
  }

  async getAllItems(): Promise<TribeMember[]> {
    return await this.storage.getAllMembers();
  }
}

/**
 * Tribe List Configuration
 */
export const tribeListConfig: ListConfig<TribeMember> = {
  // Identification
  name: 'tribes',
  browserStorageKey: 'noornote_tribes_browser',  // Legacy (for migration)
  perAccountStorageKey: StorageKeys.TRIBES,      // Per-account storage

  // Nostr Event (NIP-51: Follow Sets - one event per tribe)
  publicEventKind: 30000,       // kind:30000 (follow sets)

  // Encryption
  encryptPrivateContent: true,  // Private tribes are encrypted in content

  // Item Operations
  getItemId: (item: TribeMember) => item.pubkey,

  itemToTags: (item: TribeMember) => {
    // p-tag format: ['p', pubkey, relay (optional), petname (optional)]
    const relay = item.relay || '';
    return [['p', item.pubkey, relay]];
  },

  tagsToItem: (tags: string[][], timestamp: number): TribeMember[] => {
    // Extract all p-tags (user pubkeys)
    const items: TribeMember[] = [];

    tags.forEach(tag => {
      if (tag[0] === 'p' && tag[1]) {
        items.push({
          id: tag[1],           // Use pubkey as ID
          pubkey: tag[1],
          relay: tag[2] || '',  // Optional relay hint
          addedAt: timestamp
        });
      }
    });

    return items;
  }
  // Note: No custom decryptPrivateItems - uses GenericListOrchestrator default
  // which properly decrypts NIP-44/NIP-04 content, parses JSON tags, and converts via tagsToItem
};

/**
 * Create File Storage Wrapper instance
 */
export function createTribeFileStorageWrapper(): FileStorageWrapper<TribeMember> {
  return new TribeFileStorageWrapper();
}
