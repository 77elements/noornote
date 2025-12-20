/**
 * ListConfig - Configuration for GenericListOrchestrator
 * Defines list-specific behavior through config-driven approach
 */

import type { BaseListItem } from './BaseListItem';
import type { StorageKey } from '../services/PerAccountLocalStorage';

export interface ListConfig<T extends BaseListItem> {
  // ===== Identification =====
  name: string;                           // 'follows', 'mutes', 'bookmarks'
  browserStorageKey: string;              // localStorage key (legacy, for migration)
  perAccountStorageKey?: StorageKey;      // Per-account storage key (new, preferred)

  // ===== Nostr Event Configuration =====
  /**
   * The event kind for this list.
   * NIP-51 COMPLIANT: ONE event contains both public (tags) and private (encrypted content)
   * - Follows: kind:3
   * - Mutes: kind:10000
   * - Bookmarks: kind:10003
   */
  publicEventKind: number;

  // ===== Encryption =====
  /**
   * Whether to encrypt private items in the content field.
   * NIP-51: Private items are stored as encrypted JSON in event.content
   */
  encryptPrivateContent: boolean;

  // ===== Item Operations =====
  /**
   * Extract unique ID from item (for deduplication)
   * Examples:
   * - Follows: (item) => item.pubkey
   * - Mutes: (item) => item.id
   * - Bookmarks: (item) => item.id
   */
  getItemId: (item: T) => string;

  /**
   * Convert item to Nostr event tags
   * Examples:
   * - Follows: (item) => [['p', item.pubkey, item.relay || '', item.petname || '']]
   * - Mutes: (item) => [[item.type === 'user' ? 'p' : 'e', item.id]]
   * - Bookmarks: (item) => [[item.type, item.value]]
   */
  itemToTags: (item: T) => string[][];

  /**
   * Convert Nostr event tags back to items
   * Returns array of parsed items (empty if no valid tags)
   */
  tagsToItem: (tags: string[][], timestamp: number) => T[];

  // ===== Optional: Custom Encryption =====
  /**
   * Custom encryption function for private items
   * If not provided, uses default NIP-04/NIP-44 encryption
   *
   * Note: For mutes, content is JSON.stringify(tags)
   *       For follows, content can be empty or custom format
   */
  encryptPrivateItems?: (items: T[], pubkey: string) => Promise<string>;

  /**
   * Custom decryption function for private items
   * If not provided, uses default NIP-04/NIP-44 decryption
   */
  decryptPrivateItems?: (content: string, pubkey: string) => Promise<T[]>;
}

/**
 * File Storage Wrapper - Abstracts file operations for GenericListOrchestrator
 * Each list type provides its own implementation wrapping BaseFileStorage
 */
export interface FileStorageWrapper<T extends BaseListItem> {
  /**
   * Read public items from file
   */
  readPublic(): Promise<{ items: T[]; lastModified: number }>;

  /**
   * Write public items to file
   */
  writePublic(data: { items: T[]; lastModified: number }): Promise<void>;

  /**
   * Read private items from file
   */
  readPrivate(): Promise<{ items: T[]; lastModified: number }>;

  /**
   * Write private items to file
   */
  writePrivate(data: { items: T[]; lastModified: number }): Promise<void>;

  /**
   * Get all items (public + private merged)
   */
  getAllItems(): Promise<T[]>;
}
