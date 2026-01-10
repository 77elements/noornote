/**
 * FollowFileStorage
 * File-based storage for follow lists using Tauri FS API
 *
 * Stores follow lists in 2 separate local JSON files:
 * - ~/.noornote/follows-public.json
 * - ~/.noornote/follows-private.json
 * - Stores NIP-02 metadata (relay, petname)
 * - Accessible even when app is not running
 * - Can be manually edited/backed up
 * - Single source of truth for follows
 */

import { BaseFileStorage, type BaseFileData } from './BaseFileStorage';

/**
 * Follow item with NIP-02 metadata
 * Note: `id` is always equal to `pubkey` (for BaseListItem compatibility)
 */
export interface FollowItem {
  id: string;          // Same as pubkey (for BaseListItem compatibility)
  pubkey: string;
  relay?: string;      // NIP-02: Optional relay hint
  petname?: string;    // NIP-02: Optional local nickname
  addedAt?: number;    // Timestamp when added (for chronological order)
  isPrivate?: boolean; // True if this is a private follow (stored in browser, used by "Save to File")
}

export interface FollowListData extends BaseFileData {
  items: FollowItem[];
}

/**
 * Public follow list storage
 */
class PublicFollowStorage extends BaseFileStorage<FollowListData> {
  protected getFileName(): string {
    return 'follows-public.json';
  }

  protected getDefaultData(): FollowListData {
    return {
      items: [],
      lastModified: Math.floor(Date.now() / 1000)
    };
  }

  protected getLoggerName(): string {
    return 'PublicFollowStorage';
  }
}

/**
 * Private follow list storage
 */
class PrivateFollowStorage extends BaseFileStorage<FollowListData> {
  protected getFileName(): string {
    return 'follows-private.json';
  }

  protected getDefaultData(): FollowListData {
    return {
      items: [],
      lastModified: Math.floor(Date.now() / 1000)
    };
  }

  protected getLoggerName(): string {
    return 'PrivateFollowStorage';
  }
}

/**
 * FollowFileStorage - Facade for managing both public and private follow lists
 */
export class FollowFileStorage {
  private static instance: FollowFileStorage;
  private publicStorage: PublicFollowStorage;
  private privateStorage: PrivateFollowStorage;

  private constructor() {
    this.publicStorage = new PublicFollowStorage();
    this.privateStorage = new PrivateFollowStorage();
  }

  public static getInstance(): FollowFileStorage {
    if (!FollowFileStorage.instance) {
      FollowFileStorage.instance = new FollowFileStorage();
    }
    return FollowFileStorage.instance;
  }

  /**
   * Initialize both file storages (must be called before any file operations)
   */
  public async initialize(): Promise<void> {
    await Promise.all([
      this.publicStorage.initialize(),
      this.privateStorage.initialize()
    ]);
  }

  /**
   * Read public follow list
   */
  public async readPublic(): Promise<FollowListData> {
    return await this.publicStorage.read();
  }

  /**
   * Read private follow list
   */
  public async readPrivate(): Promise<FollowListData> {
    return await this.privateStorage.read();
  }

  /**
   * Write public follow list
   */
  public async writePublic(data: FollowListData): Promise<void> {
    await this.publicStorage.write(data);
  }

  /**
   * Write private follow list
   */
  public async writePrivate(data: FollowListData): Promise<void> {
    await this.privateStorage.write(data);
  }

  /**
   * Add public follow
   */
  public async addPublicFollow(item: FollowItem): Promise<void> {
    const data = await this.readPublic();

    // Check if already following
    const existing = data.items.find(f => f.pubkey === item.pubkey);
    if (existing) {
      // Update metadata if provided
      if (item.relay !== undefined) existing.relay = item.relay;
      if (item.petname !== undefined) existing.petname = item.petname;
    } else {
      // Add new follow
      item.addedAt = Math.floor(Date.now() / 1000);
      data.items.push(item);
    }

    await this.writePublic(data);
  }

  /**
   * Add private follow
   */
  public async addPrivateFollow(item: FollowItem): Promise<void> {
    const data = await this.readPrivate();

    // Check if already following
    const existing = data.items.find(f => f.pubkey === item.pubkey);
    if (existing) {
      // Update metadata if provided
      if (item.relay !== undefined) existing.relay = item.relay;
      if (item.petname !== undefined) existing.petname = item.petname;
    } else {
      // Add new follow
      item.addedAt = Math.floor(Date.now() / 1000);
      data.items.push(item);
    }

    await this.writePrivate(data);
  }

  /**
   * Remove follow from both lists
   */
  public async removeFollow(pubkey: string): Promise<void> {
    const publicData = await this.readPublic();
    const privateData = await this.readPrivate();

    publicData.items = publicData.items.filter(f => f.pubkey !== pubkey);
    privateData.items = privateData.items.filter(f => f.pubkey !== pubkey);

    await this.writePublic(publicData);
    await this.writePrivate(privateData);
  }

  /**
   * Get all follows (merged public + private, deduplicated)
   * If pubkey exists in both, prefer private metadata
   */
  public async getAllFollows(): Promise<FollowItem[]> {
    const publicData = await this.readPublic();
    const privateData = await this.readPrivate();

    const followMap = new Map<string, FollowItem>();

    // Add public follows
    publicData.items.forEach(item => followMap.set(item.pubkey, item));

    // Add/override with private follows (prefer private metadata)
    privateData.items.forEach(item => followMap.set(item.pubkey, item));

    return Array.from(followMap.values());
  }

  /**
   * Check if user is followed
   */
  public async isFollowing(pubkey: string): Promise<{ public: boolean; private: boolean }> {
    const publicData = await this.readPublic();
    const privateData = await this.readPrivate();

    return {
      public: publicData.items.some(f => f.pubkey === pubkey),
      private: privateData.items.some(f => f.pubkey === pubkey)
    };
  }

  /**
   * Update metadata for an existing follow (relay, petname)
   */
  public async updateMetadata(pubkey: string, relay?: string, petname?: string): Promise<boolean> {
    const publicData = await this.readPublic();
    const privateData = await this.readPrivate();
    let updated = false;

    // Update in public list if exists
    const publicItem = publicData.items.find(f => f.pubkey === pubkey);
    if (publicItem) {
      if (relay !== undefined) publicItem.relay = relay;
      if (petname !== undefined) publicItem.petname = petname;
      await this.writePublic(publicData);
      updated = true;
    }

    // Update in private list if exists
    const privateItem = privateData.items.find(f => f.pubkey === pubkey);
    if (privateItem) {
      if (relay !== undefined) privateItem.relay = relay;
      if (petname !== undefined) privateItem.petname = petname;
      await this.writePrivate(privateData);
      updated = true;
    }

    return updated;
  }

  /**
   * Get file paths (for debugging/manual access)
   */
  public getFilePaths(): { public: string | null; private: string | null } {
    return {
      public: this.publicStorage.getFilePath(),
      private: this.privateStorage.getFilePath()
    };
  }
}
