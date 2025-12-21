/**
 * @orchestrator TribeOrchestrator
 * @purpose Manages tribes (kind:30000 Follow Sets) with NIP-51 category support
 * @used-by TribeView, TribeSecondaryManager
 *
 * NIP-51 Follow Sets Architecture:
 * - Each tribe (category) = one kind:30000 event with d-tag = tribe name
 * - Root members (no tribe) = kind:30000 with d-tag = ""
 * - Private members = encrypted in content of respective tribe event
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { TribeMember } from '../storage/TribeFileStorage';
import { TribeFileStorage } from '../storage/TribeFileStorage';
import type { FetchFromRelaysResult } from '../sync/ListStorageAdapter';
import type { TribeSetData, TribeSet } from '../../types/TribeSetData';
import { GenericListOrchestrator } from './GenericListOrchestrator';
import { tribeListConfig, createTribeFileStorageWrapper } from './configs/TribeListConfig';
import { TribeFolderService } from '../TribeFolderService';

// Re-export TribeMember for external use
export type { TribeMember };

export interface MemberStatus {
  public: boolean;
  private: boolean;
}

export interface MemberWithMetadata {
  pubkey: string;
  isPrivate: boolean;
  category?: string;  // d-tag value (tribe name)
}

export class TribeOrchestrator extends GenericListOrchestrator<TribeMember> {
  private static instance: TribeOrchestrator;
  private featureFlagKey = 'noornote_nip51_private_tribes_enabled';
  private folderService: TribeFolderService;

  private constructor() {
    super('TribeOrchestrator', tribeListConfig, createTribeFileStorageWrapper());
    this.folderService = TribeFolderService.getInstance();
  }

  public static getInstance(): TribeOrchestrator {
    if (!TribeOrchestrator.instance) {
      TribeOrchestrator.instance = new TribeOrchestrator();
    }
    return TribeOrchestrator.instance;
  }

  // Required Orchestrator abstract methods
  public override onui(_data: any): void {}
  public override onopen(_relay: string): void {}
  public override onmessage(_relay: string, _event: NostrEvent): void {}
  public override onerror(_relay: string, _error: Error): void {}
  public override onclose(_relay: string): void {}

  /**
   * Check if NIP-51 private tribes feature is enabled
   */
  public isPrivateTribesEnabled(): boolean {
    try {
      const stored = localStorage.getItem(this.featureFlagKey);
      return stored === 'true';
    } catch {
      return false;
    }
  }

  /**
   * Enable/disable NIP-51 private tribes feature
   */
  public setPrivateTribesEnabled(enabled: boolean): void {
    try {
      localStorage.setItem(this.featureFlagKey, enabled.toString());
    } catch (error) {
      this.systemLogger.error('TribeOrchestrator', `Failed to save NIP-51 private tribes flag: ${error}`);
    }
  }

  /**
   * Check if a user is a tribe member (public, private, or both)
   * Reads from browserItems (localStorage)
   */
  public async isMember(pubkey: string): Promise<MemberStatus> {
    try {
      const browserItems = this.getBrowserItems();
      const item = browserItems.find(m => m.pubkey === pubkey);

      if (!item) {
        return { public: false, private: false };
      }

      if (item.isPrivate) {
        return { public: false, private: true };
      } else {
        return { public: true, private: false };
      }
    } catch (error) {
      this.systemLogger.error('TribeOrchestrator', `Failed to check member status: ${error}`);
      return { public: false, private: false };
    }
  }

  /**
   * Add a tribe member (public or private)
   * Writes to browserItems (localStorage)
   */
  public async addMember(pubkey: string, isPrivate: boolean, category: string = ''): Promise<boolean> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      throw new Error('User not authenticated');
    }

    try {
      const browserItems = this.getBrowserItems();

      if (browserItems.some(m => m.pubkey === pubkey)) {
        return true; // Already a member
      }

      // Security: Only allow private members if feature is enabled
      const canBePrivate = isPrivate && this.isPrivateTribesEnabled();

      const item: TribeMember = {
        id: pubkey,
        pubkey: pubkey,
        relay: '',
        addedAt: Math.floor(Date.now() / 1000),
        isPrivate: canBePrivate,
        category: category
      };

      await this.addItem(item);

      // Keep folderService in sync for UI
      if (category === '') {
        this.folderService.ensureMemberAssignment(pubkey);
      } else {
        // Move to specified folder
        this.folderService.ensureMemberAssignment(pubkey); // Create assignment first
        this.folderService.moveMemberToFolder(pubkey, category);
      }

      this.systemLogger.info('TribeOrchestrator',
        `Added ${canBePrivate ? 'private' : 'public'} member to "${category || 'root'}": ${pubkey.slice(0, 8)}...`
      );

      this.eventBus.emit('tribe:updated', {});
      return true;
    } catch (error) {
      this.systemLogger.error('TribeOrchestrator', `Failed to add member: ${error}`);
      throw error;
    }
  }

  /**
   * Remove a tribe member (public or private)
   * Writes to browserItems (localStorage)
   */
  public async removeMember(pubkey: string): Promise<boolean> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      throw new Error('User not authenticated');
    }

    try {
      await this.removeItem(pubkey);

      // Remove folder assignment
      this.folderService.removeMemberAssignment(pubkey);

      this.systemLogger.info('TribeOrchestrator', `Removed member (local): ${pubkey.slice(0, 8)}...`);

      this.eventBus.emit('tribe:updated', {});
      return true;
    } catch (error) {
      this.systemLogger.error('TribeOrchestrator', `Failed to remove member: ${error}`);
      throw error;
    }
  }

  /**
   * Get all tribe members (merged public + private)
   */
  public async getAllMembers(_pubkey: string): Promise<string[]> {
    try {
      const browserItems = this.getBrowserItems();

      // If empty, try to load from files
      if (browserItems.length === 0) {
        const fileItems = await this.fileStorage.getAllItems();
        if (fileItems.length > 0) {
          this.setBrowserItems(fileItems);
          return fileItems.map(item => item.pubkey);
        }
      }

      const memberPubkeys = browserItems.map(item => item.pubkey);

      this.systemLogger.info('TribeOrchestrator',
        `Loaded ${memberPubkeys.length} members from browserItems`
      );

      return memberPubkeys;
    } catch (error) {
      this.systemLogger.error('TribeOrchestrator', `Failed to fetch members: ${error}`);
      return [];
    }
  }

  /**
   * Get all tribe members with metadata (public/private indicator)
   */
  public async getAllMembersWithMetadata(_pubkey: string): Promise<MemberWithMetadata[]> {
    try {
      const browserItems = this.getBrowserItems();

      // If empty, try to load from files
      if (browserItems.length === 0) {
        const fileItems = await this.fileStorage.getAllItems();
        if (fileItems.length > 0) {
          this.setBrowserItems(fileItems);
          return fileItems.map(item => ({
            pubkey: item.pubkey,
            isPrivate: item.isPrivate || false,
            category: item.category
          }));
        }
      }

      const result = browserItems.map(item => ({
        pubkey: item.pubkey,
        isPrivate: item.isPrivate || false,
        category: item.category
      }));

      this.systemLogger.info('TribeOrchestrator',
        `Loaded ${result.length} members with metadata from browserItems`
      );

      return result;
    } catch (error) {
      this.systemLogger.error('TribeOrchestrator', `Failed to fetch members: ${error}`);
      return [];
    }
  }

  // ===== File & Relay Sync =====

  /**
   * Save to file (override to use TribeSetData format)
   */
  public override async saveToFile(): Promise<void> {
    const setData = this.buildSetDataFromLocalStorage();
    const storage = TribeFileStorage.getInstance();
    await storage.write(setData);

    this.systemLogger.info('TribeOrchestrator',
      `Saved to file: ${setData.sets.length} sets`
    );
  }

  /**
   * Publish to relays (manual sync via UI button)
   *
   * NIP-51 Follow Sets:
   * - Root members → d: ""
   * - Tribe "Devs" → d: "Devs"
   * - Private members → encrypted in content
   * - Deleted tribes → publish empty event to overwrite
   */
  public override async publishToRelays(): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      throw new Error('User not authenticated');
    }

    const writeRelays = this.transport.getWriteRelays();
    if (writeRelays.length === 0) {
      throw new Error('No write relays available');
    }

    // Build TribeSetData from localStorage
    const setData = this.buildSetDataFromLocalStorage();
    const localTribes = new Set(setData.sets.map(s => s.d));

    // Fetch existing tribes from relays to find deleted ones
    const relayResult = await this.fetchFromRelays(currentUser.pubkey);
    const relayTribes = new Set(relayResult.categories || []);

    // Find tribes that exist on relays but not locally (deleted)
    const deletedTribes: string[] = [];
    for (const relayTribe of relayTribes) {
      if (!localTribes.has(relayTribe)) {
        deletedTribes.push(relayTribe);
      }
    }

    this.systemLogger.info('TribeOrchestrator',
      `Publishing: ${setData.sets.length} sets, ${deletedTribes.length} deleted tribes`
    );

    // First, publish empty events for deleted tribes
    for (const tribeName of deletedTribes) {
      await this.publishEmptyTribe(tribeName);
    }

    // Publish each tribe
    let totalPublished = 0;

    for (const set of setData.sets) {
      // Skip empty sets (except root)
      if (set.publicMembers.length === 0 && set.privateMembers.length === 0 && set.d !== '') {
        continue;
      }

      // Build tags
      const tags: string[][] = [
        ['d', set.d],
        ['title', set.title || set.d],
        ['client', 'NoorNote']
      ];

      // Add public p-tags
      for (const member of set.publicMembers) {
        tags.push(['p', member.pubkey, member.relay || '']);
      }

      // Build encrypted content for private members
      let content = '';
      if (set.privateMembers.length > 0) {
        const privateItems: TribeMember[] = set.privateMembers.map(m => ({
          id: m.pubkey,
          pubkey: m.pubkey,
          relay: m.relay,
          isPrivate: true
        }));
        content = await this.encryptPrivateItems(privateItems, currentUser.pubkey);
      }

      const event = {
        kind: 30000,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content,
        pubkey: currentUser.pubkey
      };

      const signed = await this.authService.signEvent(event);
      if (!signed) {
        this.systemLogger.error('TribeOrchestrator', `Failed to sign event for tribe: ${set.d}`);
        continue;
      }

      await this.transport.publish(writeRelays, signed);
      totalPublished++;

      this.systemLogger.info('TribeOrchestrator',
        `Published tribe "${set.d || 'root'}": ${set.publicMembers.length} public + ${set.privateMembers.length} private`
      );
    }

    this.systemLogger.info('TribeOrchestrator',
      `Published ${totalPublished} tribe set events + ${deletedTribes.length} deletions to relays`
    );
  }

  /**
   * Publish an empty event for a tribe to "delete" it from relays
   * This overwrites the existing event with an empty one
   */
  public async publishEmptyTribe(tribeName: string): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      throw new Error('User not authenticated');
    }

    const writeRelays = this.transport.getWriteRelays();
    if (writeRelays.length === 0) {
      throw new Error('No write relays available');
    }

    // Build empty event with this d-tag
    const tags: string[][] = [
      ['d', tribeName],
      ['title', tribeName],
      ['client', 'NoorNote']
    ];

    const event = {
      kind: 30000,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: '',
      pubkey: currentUser.pubkey
    };

    const signed = await this.authService.signEvent(event);
    if (!signed) {
      throw new Error(`Failed to sign empty event for tribe: ${tribeName}`);
    }

    await this.transport.publish(writeRelays, signed);

    this.systemLogger.info('TribeOrchestrator',
      `Published empty event to delete tribe "${tribeName}" from relays`
    );
  }

  /**
   * Build TribeSetData from localStorage with CORRECT ORDER from FolderService
   * Uses FolderService.getMembersInFolder() to preserve user's manual ordering
   */
  private buildSetDataFromLocalStorage(): TribeSetData {
    const allItems = this.getBrowserItems();

    // Build item lookup map (pubkey -> item)
    const itemMap = new Map<string, TribeMember>();
    for (const item of allItems) {
      itemMap.set(item.pubkey, item);
    }

    // Create sets map
    const setsMap = new Map<string, TribeSet>();

    // Initialize root set
    setsMap.set('', {
      kind: 30000,
      d: '',
      title: '',
      publicMembers: [],
      privateMembers: []
    });

    // Get all folders from FolderService
    const existingFolders = this.folderService.getFolders();

    // Create sets for each folder (tribe)
    for (const folder of existingFolders) {
      setsMap.set(folder.name, {
        kind: 30000,
        d: folder.name,
        title: folder.name,
        publicMembers: [],
        privateMembers: []
      });
    }

    // Track which items have been assigned (to catch orphans)
    const assignedItemIds = new Set<string>();

    // Process each folder IN ORDER from FolderService
    for (const folder of existingFolders) {
      const set = setsMap.get(folder.name)!;
      // getMembersInFolder returns pubkeys sorted by order field
      const sortedMemberIds = this.folderService.getMembersInFolder(folder.id);

      for (const memberId of sortedMemberIds) {
        const item = itemMap.get(memberId);
        if (item) {
          const memberTag = { pubkey: item.pubkey, relay: item.relay };
          if (item.isPrivate) {
            set.privateMembers.push(memberTag);
          } else {
            set.publicMembers.push(memberTag);
          }
          assignedItemIds.add(memberId);
        }
      }
    }

    // Process root items IN ORDER from FolderService
    const rootSet = setsMap.get('')!;
    const sortedRootMemberIds = this.folderService.getMembersInFolder('');

    for (const memberId of sortedRootMemberIds) {
      const item = itemMap.get(memberId);
      if (item) {
        const memberTag = { pubkey: item.pubkey, relay: item.relay };
        if (item.isPrivate) {
          rootSet.privateMembers.push(memberTag);
        } else {
          rootSet.publicMembers.push(memberTag);
        }
        assignedItemIds.add(memberId);
      }
    }

    // Handle orphaned items (in browserItems but not in FolderService) - add to root
    for (const item of allItems) {
      if (!assignedItemIds.has(item.pubkey)) {
        const memberTag = { pubkey: item.pubkey, relay: item.relay };
        if (item.isPrivate) {
          rootSet.privateMembers.push(memberTag);
        } else {
          rootSet.publicMembers.push(memberTag);
        }
        // Also ensure FolderService knows about this item
        this.folderService.ensureMemberAssignment(item.pubkey);
      }
    }

    // Build setOrder (root first, then by folder order)
    const setOrder = ['', ...existingFolders.map(f => f.name)];

    return {
      version: 1,
      sets: Array.from(setsMap.values()),
      metadata: {
        setOrder,
        lastModified: Math.floor(Date.now() / 1000)
      }
    };
  }

  /**
   * Fetch tribes from relays (read-only, no local changes)
   * Fetches ALL kind:30000 events for the user and extracts tribes
   */
  public override async fetchFromRelays(pubkey: string): Promise<FetchFromRelaysResult<TribeMember>> {
    const relays = this.getBootstrapRelays();

    try {
      // Fetch ALL kind:30000 events (all tribes)
      const events = await this.transport.fetch(relays, [{
        authors: [pubkey],
        kinds: [30000],
        limit: 100  // Support up to 100 tribes
      }], 10000);

      if (events.length === 0) {
        this.systemLogger.info('TribeOrchestrator', 'No tribe sets found on relays');
        return { items: [], relayContentWasEmpty: true };
      }

      // Deduplicate by d-tag (keep newest per tribe)
      const eventsByDTag = new Map<string, NostrEvent>();
      events.forEach(event => {
        const dTag = event.tags.find(t => t[0] === 'd')?.[1] || '';
        const existing = eventsByDTag.get(dTag);
        if (!existing || event.created_at > existing.created_at) {
          eventsByDTag.set(dTag, event);
        }
      });

      const allItems: TribeMember[] = [];
      const categoryAssignments = new Map<string, string>(); // pubkey -> tribeName
      const categories: string[] = [];
      let anyContentWasEmpty = true;

      for (const [tribeName, event] of eventsByDTag) {
        // Track all tribes (including root "")
        categories.push(tribeName);

        const hasContent = event.content && event.content.trim() !== '';
        if (hasContent) anyContentWasEmpty = false;

        // Extract public members from p-tags
        const publicItems = this.config.tagsToItem(
          event.tags.filter(t => t[0] !== 'd' && t[0] !== 'title'),
          event.created_at
        );
        publicItems.forEach(item => {
          item.isPrivate = false;
          item.category = tribeName;  // Set category directly on item
          categoryAssignments.set(item.pubkey, tribeName);
        });

        // Extract private members from encrypted content
        let privateItems: TribeMember[] = [];
        if (hasContent) {
          try {
            privateItems = await this.decryptPrivateItems(event, pubkey);
            privateItems.forEach(item => {
              item.isPrivate = true;
              item.category = tribeName;  // Set category directly on item
              categoryAssignments.set(item.pubkey, tribeName);
            });
          } catch (error) {
            this.systemLogger.error('TribeOrchestrator',
              `Failed to decrypt private members for tribe "${tribeName}": ${error}`
            );
          }
        }

        allItems.push(...publicItems, ...privateItems);

        this.systemLogger.info('TribeOrchestrator',
          `Fetched tribe "${tribeName || 'root'}": ${publicItems.length} public + ${privateItems.length} private`
        );
      }

      // Deduplicate by pubkey
      const itemMap = new Map<string, TribeMember>();
      allItems.forEach(item => itemMap.set(this.config.getItemId(item), item));

      return {
        items: Array.from(itemMap.values()),
        relayContentWasEmpty: anyContentWasEmpty,
        categoryAssignments,
        categories
      };
    } catch (error) {
      this.systemLogger.error('TribeOrchestrator', `Failed to fetch from relays: ${error}`);
      return { items: [], relayContentWasEmpty: true };
    }
  }

  /**
   * Sync from relays (manual sync)
   * Fetches all tribes and merges with local
   * Creates folders from relay tribes and assigns members
   */
  public override async syncFromRelays(pubkey: string): Promise<{ added: number; total: number }> {
    const relays = this.getBootstrapRelays();
    this.systemLogger.info('TribeOrchestrator', `Syncing from relays (${relays.length} relays)...`);

    try {
      const fetchResult = await this.fetchFromRelays(pubkey);
      const localItems = this.getBrowserItems();

      // Merge (union)
      const merged = this.mergeItems(localItems, fetchResult.items);
      const added = merged.length - localItems.length;

      this.setBrowserItems(merged);

      // Create folders only for tribes that have members (skip empty sets)
      const existingFolders = this.folderService.getFolders();
      const categoryAssignments = fetchResult.categoryAssignments;

      // Collect tribes that actually have members
      const tribesWithMembers = new Set<string>();
      if (categoryAssignments) {
        for (const [, tribeName] of categoryAssignments) {
          if (tribeName !== '') {
            tribesWithMembers.add(tribeName);
          }
        }
      }

      for (const tribeName of tribesWithMembers) {
        // Check if folder with this name exists
        const existingFolder = existingFolders.find(f => f.name === tribeName);
        if (!existingFolder) {
          this.folderService.createFolder(tribeName);
          this.systemLogger.info('TribeOrchestrator', `Created tribe from relay: "${tribeName}"`);
        }
      }

      // Assign members to their tribes from relay, preserving order
      // Only assign tribes for NEW members (not in local storage before sync)
      // Existing members keep their local tribe assignment - user's manual organization takes precedence
      if (categoryAssignments) {
        const updatedFolders = this.folderService.getFolders(); // Refresh after creating new folders

        // Build set of local member pubkeys (before merge) for fast lookup
        const localMemberPubkeys = new Set(localItems.map(item => item.pubkey));

        // Track order per tribe
        const orderByTribe = new Map<string, number>();

        for (const [memberPubkey, tribeName] of categoryAssignments) {
          const isNewMember = !localMemberPubkeys.has(memberPubkey);

          // Get next order for this tribe
          const currentOrder = orderByTribe.get(tribeName) ?? 0;
          orderByTribe.set(tribeName, currentOrder + 1);

          if (isNewMember) {
            // NEW member: assign relay tribe with preserved order
            if (tribeName === '') {
              this.folderService.ensureMemberAssignment(memberPubkey, currentOrder);
            } else {
              const folder = updatedFolders.find(f => f.name === tribeName);
              if (folder) {
                this.folderService.moveMemberToFolder(memberPubkey, folder.id, currentOrder);
              } else {
                // Folder doesn't exist locally, assign to root
                this.folderService.ensureMemberAssignment(memberPubkey);
                this.systemLogger.warn('TribeOrchestrator',
                  `Tribe "${tribeName}" not found, assigned member ${memberPubkey.slice(0, 8)}... to root`
                );
              }
            }
          }
          // EXISTING member: Skip - keep local tribe assignment
        }
      }

      this.systemLogger.info('TribeOrchestrator',
        `Sync complete: ${added} new members, ${tribesWithMembers.size} tribes`
      );

      return { added, total: merged.length };
    } catch (error) {
      this.systemLogger.error('TribeOrchestrator', `Sync from relays failed: ${error}`);
      throw error;
    }
  }

  /**
   * Fetch tribes from relays (read-only wrapper)
   */
  public async fetchTribesFromRelays(pubkey: string): Promise<FetchFromRelaysResult<TribeMember>> {
    return await this.fetchFromRelays(pubkey);
  }
}
