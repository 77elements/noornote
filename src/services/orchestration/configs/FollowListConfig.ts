/**
 * FollowListConfig - Configuration for follow list management
 * Used by FollowListOrchestrator via GenericListOrchestrator
 */

import type { ListConfig, FileStorageWrapper } from '../../../types/ListConfig';
import type { FollowItem } from '../../storage/FollowFileStorage';
import { FollowFileStorage } from '../../storage/FollowFileStorage';
import { StorageKeys } from '../../PerAccountLocalStorage';

/**
 * File Storage Wrapper for Follows
 */
class FollowFileStorageWrapper implements FileStorageWrapper<FollowItem> {
  private storage: FollowFileStorage;

  constructor() {
    this.storage = FollowFileStorage.getInstance();
  }

  async readPublic(): Promise<{ items: FollowItem[]; lastModified: number }> {
    return await this.storage.readPublic();
  }

  async writePublic(data: { items: FollowItem[]; lastModified: number }): Promise<void> {
    await this.storage.writePublic(data);
  }

  async readPrivate(): Promise<{ items: FollowItem[]; lastModified: number }> {
    return await this.storage.readPrivate();
  }

  async writePrivate(data: { items: FollowItem[]; lastModified: number }): Promise<void> {
    await this.storage.writePrivate(data);
  }

  async getAllItems(): Promise<FollowItem[]> {
    return await this.storage.getAllFollows();
  }
}

/**
 * Follow List Configuration
 */
export const followListConfig: ListConfig<FollowItem> = {
  // Identification
  name: 'follows',
  browserStorageKey: 'noornote_follows_browser',  // Legacy (for migration)
  perAccountStorageKey: StorageKeys.FOLLOWS,      // Per-account storage

  // Nostr Event (NIP-51: ONE event with public tags + encrypted private content)
  publicEventKind: 3,           // kind:3 (contact list)

  // Encryption
  encryptPrivateContent: true,  // Private follows are encrypted in content

  // Item Operations
  getItemId: (item: FollowItem) => item.pubkey,

  itemToTags: (item: FollowItem) => {
    const tag: string[] = ['p', item.pubkey];
    if (item.relay) tag.push(item.relay);
    if (item.petname) tag.push(item.petname);
    return [tag];
  },

  tagsToItem: (tags: string[][], timestamp: number): FollowItem[] => {
    // Extract all 'p' tags
    const items: FollowItem[] = [];

    tags.forEach(tag => {
      if (tag[0] === 'p' && tag[1]) {
        items.push({
          pubkey: tag[1],
          relay: tag[2] || undefined,
          petname: tag[3] || undefined,
          addedAt: timestamp
        });
      }
    });

    return items;
  },

  // Custom encryption/decryption (follows use special format)
  encryptPrivateItems: async (items: FollowItem[], pubkey: string): Promise<string> => {
    // Import helper
    const { encryptPrivateFollows } = await import('../../../helpers/encryptPrivateFollows');
    const pubkeys = items.map(item => item.pubkey);
    return await encryptPrivateFollows(pubkeys, pubkey);
  },

  decryptPrivateItems: async (content: string, pubkey: string): Promise<FollowItem[]> => {
    // Import helper
    const { decryptPrivateFollows } = await import('../../../helpers/decryptPrivateFollows');
    const pubkeys = await decryptPrivateFollows(content, pubkey);
    return pubkeys.map(pk => ({
      pubkey: pk,
      addedAt: Math.floor(Date.now() / 1000)
    }));
  }
};

/**
 * Create File Storage Wrapper instance
 */
export function createFollowFileStorageWrapper(): FileStorageWrapper<FollowItem> {
  return new FollowFileStorageWrapper();
}
