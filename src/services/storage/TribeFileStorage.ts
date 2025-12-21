/**
 * TribeFileStorage
 * File-based storage for tribe lists using Tauri FS API
 *
 * Stores tribes in a single file with the sets-based format:
 * - ~/.noornote/{npub}/tribes.json
 *
 * Format (TribeSetData):
 * {
 *   "version": 1,
 *   "sets": [
 *     { "d": "", "title": "", "publicMembers": [...], "privateMembers": [...] },
 *     { "d": "Devs", "title": "Devs", "publicMembers": [...], "privateMembers": [...] }
 *   ],
 *   "metadata": { "setOrder": ["", "Devs"], "lastModified": ... }
 * }
 * Note: d-tag = title-tag (always equal)
 */

import { BaseFileStorage } from './BaseFileStorage';
import type { TribeSetData } from '../../types/TribeSetData';

/**
 * Tribe member with NIP-51 p-tag support
 * category = d-tag value ('' for root, 'Devs' for tribe Devs, etc.)
 */
export interface TribeMember {
  id: string;          // pubkey (used as ID)
  pubkey: string;
  relay?: string;      // Optional relay hint
  addedAt?: number;
  isPrivate?: boolean;
  category?: string;   // d-tag value, '' = root
}

/**
 * Create empty TribeSetData
 */
function createEmptyTribeSetData(): TribeSetData {
  return {
    version: 1,
    sets: [
      {
        kind: 30000,
        d: '',
        title: '',
        publicMembers: [],
        privateMembers: []
      }
    ],
    metadata: {
      setOrder: [''],
      lastModified: Math.floor(Date.now() / 1000)
    }
  };
}

/**
 * Internal storage class for TribeSetData
 */
class TribeSetStorage extends BaseFileStorage<TribeSetData> {
  protected getFileName(): string {
    return 'tribes.json';
  }

  protected getDefaultData(): TribeSetData {
    return createEmptyTribeSetData();
  }

  protected getLoggerName(): string {
    return 'TribeSetStorage';
  }
}

/**
 * TribeFileStorage - Unified storage using TribeSetData format
 */
export class TribeFileStorage {
  private static instance: TribeFileStorage;
  private storage: TribeSetStorage;

  private constructor() {
    this.storage = new TribeSetStorage();
  }

  public static getInstance(): TribeFileStorage {
    if (!TribeFileStorage.instance) {
      TribeFileStorage.instance = new TribeFileStorage();
    }
    return TribeFileStorage.instance;
  }

  /**
   * Initialize storage
   */
  public async initialize(): Promise<void> {
    await this.storage.initialize();
  }

  /**
   * Read tribe data
   */
  public async read(): Promise<TribeSetData> {
    await this.initialize();
    return await this.storage.read();
  }

  /**
   * Write tribe data
   */
  public async write(data: TribeSetData): Promise<void> {
    await this.initialize();
    data.metadata.lastModified = Math.floor(Date.now() / 1000);
    await this.storage.write(data);
  }

  // ===== API for ListStorageAdapter =====

  /**
   * Read public tribe list (for ListStorageAdapter)
   */
  public async readPublic(): Promise<{ items: TribeMember[]; lastModified: number }> {
    const data = await this.read();
    const items = this.extractMembers(data, false);
    return {
      items,
      lastModified: data.metadata.lastModified
    };
  }

  /**
   * Read private tribe list (for ListStorageAdapter)
   */
  public async readPrivate(): Promise<{ items: TribeMember[]; lastModified: number }> {
    const data = await this.read();
    const items = this.extractMembers(data, true);
    return {
      items,
      lastModified: data.metadata.lastModified
    };
  }

  /**
   * Write public tribe list (for ListStorageAdapter)
   */
  public async writePublic(input: { items: TribeMember[]; lastModified: number }): Promise<void> {
    const currentData = await this.read();

    // Remove all public members from all sets
    for (const set of currentData.sets) {
      set.publicMembers = [];
    }

    // Add items to appropriate sets based on category
    for (const item of input.items) {
      const setName = item.category || '';

      let set = currentData.sets.find(s => s.d === setName);
      if (!set) {
        set = {
          kind: 30000,
          d: setName,
          title: setName,
          publicMembers: [],
          privateMembers: []
        };
        currentData.sets.push(set);
        currentData.metadata.setOrder.push(setName);
      }
      set.publicMembers.push({
        pubkey: item.pubkey,
        relay: item.relay
      });
    }

    await this.write(currentData);
  }

  /**
   * Write private tribe list (for ListStorageAdapter)
   */
  public async writePrivate(input: { items: TribeMember[]; lastModified: number }): Promise<void> {
    const currentData = await this.read();

    // Remove all private members from all sets
    for (const set of currentData.sets) {
      set.privateMembers = [];
    }

    // Add items to appropriate sets based on category
    for (const item of input.items) {
      const setName = item.category || '';

      let set = currentData.sets.find(s => s.d === setName);
      if (!set) {
        set = {
          kind: 30000,
          d: setName,
          title: setName,
          publicMembers: [],
          privateMembers: []
        };
        currentData.sets.push(set);
        currentData.metadata.setOrder.push(setName);
      }
      set.privateMembers.push({
        pubkey: item.pubkey,
        relay: item.relay
      });
    }

    await this.write(currentData);
  }

  /**
   * Get all tribe members with category info
   */
  public async getAllMembers(): Promise<TribeMember[]> {
    const data = await this.read();
    const members: TribeMember[] = [];

    for (const set of data.sets) {
      const category = set.d;  // d-tag = category

      // Add public members
      for (const member of set.publicMembers) {
        if (!members.some(m => m.pubkey === member.pubkey)) {
          members.push({
            id: member.pubkey,
            pubkey: member.pubkey,
            relay: member.relay,
            addedAt: data.metadata.lastModified,
            isPrivate: false,
            category
          });
        }
      }
      // Add private members
      for (const member of set.privateMembers) {
        if (!members.some(m => m.pubkey === member.pubkey)) {
          members.push({
            id: member.pubkey,
            pubkey: member.pubkey,
            relay: member.relay,
            addedAt: data.metadata.lastModified,
            isPrivate: true,
            category
          });
        }
      }
    }

    return members;
  }

  /**
   * Extract members from TribeSetData
   */
  private extractMembers(data: TribeSetData, privateOnly: boolean): TribeMember[] {
    const members: TribeMember[] = [];

    for (const set of data.sets) {
      const memberTags = privateOnly ? set.privateMembers : set.publicMembers;
      const category = set.d;

      for (const member of memberTags) {
        members.push({
          id: member.pubkey,
          pubkey: member.pubkey,
          relay: member.relay,
          addedAt: data.metadata.lastModified,
          isPrivate: privateOnly,
          category
        });
      }
    }

    return members;
  }

  /**
   * Get file path
   */
  public getFilePath(): string | null {
    return this.storage.getFilePath();
  }
}
