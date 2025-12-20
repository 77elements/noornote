/**
 * MuteListConfig - Configuration for mute list management
 * Used by MuteOrchestrator via GenericListOrchestrator
 */

import type { ListConfig, FileStorageWrapper } from '../../../types/ListConfig';
import type { MuteItem } from '../../../types/BaseListItem';
import { MuteFileStorage } from '../../storage/MuteFileStorage';
import { StorageKeys } from '../../PerAccountLocalStorage';

/**
 * File Storage Wrapper for Mutes
 * Converts between old file format (items[], eventIds[]) and new MuteItem[]
 */
class MuteFileStorageWrapper implements FileStorageWrapper<MuteItem> {
  private storage: MuteFileStorage;

  constructor() {
    this.storage = MuteFileStorage.getInstance();
  }

  async readPublic(): Promise<{ items: MuteItem[]; lastModified: number }> {
    const data = await this.storage.readPublic();
    const items: MuteItem[] = [
      ...data.items.map(id => ({ id, type: 'user' as const, addedAt: data.lastModified })),
      ...data.eventIds.map(id => ({ id, type: 'thread' as const, addedAt: data.lastModified }))
    ];
    return { items, lastModified: data.lastModified };
  }

  async writePublic(data: { items: MuteItem[]; lastModified: number }): Promise<void> {
    const users = data.items.filter(item => item.type === 'user').map(item => item.id);
    const threads = data.items.filter(item => item.type === 'thread').map(item => item.id);
    await this.storage.writePublic({
      items: users,
      eventIds: threads,
      lastModified: data.lastModified
    });
  }

  async readPrivate(): Promise<{ items: MuteItem[]; lastModified: number }> {
    const data = await this.storage.readPrivate();
    const items: MuteItem[] = [
      ...data.items.map(id => ({ id, type: 'user' as const, addedAt: data.lastModified, isPrivate: true })),
      ...data.eventIds.map(id => ({ id, type: 'thread' as const, addedAt: data.lastModified, isPrivate: true }))
    ];
    return { items, lastModified: data.lastModified };
  }

  async writePrivate(data: { items: MuteItem[]; lastModified: number }): Promise<void> {
    const users = data.items.filter(item => item.type === 'user').map(item => item.id);
    const threads = data.items.filter(item => item.type === 'thread').map(item => item.id);
    await this.storage.writePrivate({
      items: users,
      eventIds: threads,
      lastModified: data.lastModified
    });
  }

  async getAllItems(): Promise<MuteItem[]> {
    const publicData = await this.readPublic();
    const privateData = await this.readPrivate();
    return [...publicData.items, ...privateData.items];
  }
}

/**
 * Mute List Configuration
 */
export const muteListConfig: ListConfig<MuteItem> = {
  // Identification
  name: 'mutes',
  browserStorageKey: 'noornote_mutes_browser_v2',  // Legacy (for migration)
  perAccountStorageKey: StorageKeys.MUTES,         // Per-account storage

  // Nostr Event (NIP-51: ONE event with public tags + encrypted private content)
  publicEventKind: 10000,       // kind:10000 (mute list)

  // Encryption
  encryptPrivateContent: true,  // Private mutes are encrypted in content

  // Item Operations
  getItemId: (item: MuteItem) => item.id,

  itemToTags: (item: MuteItem) => {
    const tagType = item.type === 'user' ? 'p' : 'e';
    return [[tagType, item.id]];
  },

  tagsToItem: (tags: string[][], timestamp: number): MuteItem[] => {
    // Extract all 'p' (user) and 'e' (thread) tags
    const items: MuteItem[] = [];

    tags.forEach(tag => {
      if (tag[0] === 'p' && tag[1]) {
        items.push({
          id: tag[1],
          type: 'user',
          addedAt: timestamp
        });
      } else if (tag[0] === 'e' && tag[1]) {
        items.push({
          id: tag[1],
          type: 'thread',
          addedAt: timestamp
        });
      }
    });

    return items;
  },

  // Custom encryption: Mutes encrypt tags as JSON
  encryptPrivateItems: async (items: MuteItem[], pubkey: string): Promise<string> => {
    // Convert to tags format
    const tags: string[][] = items.map(item => {
      const tagType = item.type === 'user' ? 'p' : 'e';
      return [tagType, item.id];
    });

    const plaintext = JSON.stringify(tags);

    // Use AuthService for encryption
    const { AuthService } = await import('../../AuthService');
    const authService = AuthService.getInstance();
    const authMethod = authService.getAuthMethod();

    if (authMethod === 'key-signer') {
      const { KeySignerClient } = await import('../../KeySignerClient');
      const keySignerClient = KeySignerClient.getInstance();
      try {
        return await keySignerClient.nip44Encrypt(plaintext, pubkey);
      } catch {
        return await keySignerClient.nip04Encrypt(plaintext, pubkey);
      }
    } else if (authMethod === 'nip46') {
      const nip46Manager = (authService as any).nip46Manager;
      try {
        return await nip46Manager.nip44Encrypt(plaintext, pubkey);
      } catch {
        return await nip46Manager.nip04Encrypt(plaintext, pubkey);
      }
    } else if (authMethod === 'extension') {
      try {
        if (window.nostr?.nip44?.encrypt) {
          return await window.nostr.nip44.encrypt(pubkey, plaintext);
        }
        throw new Error('NIP-44 not available');
      } catch (_nip44Error) {
        if (window.nostr?.nip04?.encrypt) {
          return await window.nostr.nip04.encrypt(pubkey, plaintext);
        }
        throw new Error('No encryption available');
      }
    } else if (authMethod === 'nsec') {
      const currentUser = authService.getCurrentUser();
      if (!currentUser?.privateKey) {
        throw new Error('No private key available');
      }
      const { nip04 } = await import('../../NostrToolsAdapter');
      return await nip04.encrypt(currentUser.privateKey, pubkey, plaintext);
    }

    throw new Error(`Unsupported auth method: ${authMethod}`);
  },

  // Custom decryption: Decrypt content, then parse tags from JSON
  decryptPrivateItems: async (content: string, pubkey: string): Promise<MuteItem[]> => {
    try {
      // First, decrypt the content
      const { AuthService } = await import('../../AuthService');
      const authService = AuthService.getInstance();
      const authMethod = authService.getAuthMethod();

      let plaintext: string | null = null;

      if (authMethod === 'key-signer') {
        const { KeySignerClient } = await import('../../KeySignerClient');
        const keySignerClient = KeySignerClient.getInstance();
        try {
          plaintext = await keySignerClient.nip44Decrypt(content, pubkey);
        } catch {
          plaintext = await keySignerClient.nip04Decrypt(content, pubkey);
        }
      } else if (authMethod === 'nip46') {
        const nip46Manager = (authService as any).nip46Manager;
        try {
          plaintext = await nip46Manager.nip44Decrypt(content, pubkey);
        } catch {
          plaintext = await nip46Manager.nip04Decrypt(content, pubkey);
        }
      } else if (authMethod === 'extension') {
        if (window.nostr?.nip44?.decrypt) {
          try {
            plaintext = await window.nostr.nip44.decrypt(pubkey, content);
          } catch {}
        }
        if (!plaintext && window.nostr?.nip04?.decrypt) {
          plaintext = await window.nostr.nip04.decrypt(pubkey, content);
        }
      } else if (authMethod === 'nsec') {
        const currentUser = authService.getCurrentUser();
        if (currentUser?.privateKey) {
          const { nip04 } = await import('../../NostrToolsAdapter');
          plaintext = await nip04.decrypt(currentUser.privateKey, pubkey, content);
        }
      }

      if (!plaintext) {
        return [];
      }

      // Now parse the decrypted JSON
      const tags: string[][] = JSON.parse(plaintext);
      const items: MuteItem[] = [];

      tags.forEach(tag => {
        if (Array.isArray(tag) && tag[0] === 'p' && tag[1]) {
          items.push({
            id: tag[1],
            type: 'user',
            addedAt: Math.floor(Date.now() / 1000),
            isPrivate: true
          });
        } else if (Array.isArray(tag) && tag[0] === 'e' && tag[1]) {
          items.push({
            id: tag[1],
            type: 'thread',
            addedAt: Math.floor(Date.now() / 1000),
            isPrivate: true
          });
        }
      });

      return items;
    } catch (error) {
      console.error('[MuteListConfig] Failed to decrypt private items:', error);
      return [];
    }
  }
};

/**
 * Create File Storage Wrapper instance
 */
export function createMuteFileStorageWrapper(): FileStorageWrapper<MuteItem> {
  return new MuteFileStorageWrapper();
}
