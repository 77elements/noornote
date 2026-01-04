/**
 * @orchestrator MuteOrchestrator
 * @purpose Manages mute lists (kind:10000) with file-based storage + relay sync
 * @used-by NoteMenu, FeedOrchestrator, NotificationsOrchestrator
 *
 * REFACTORED: Now uses GenericListOrchestrator with unified MuteItem[] format
 *
 * Migration: 4 separate localStorage keys → 1 unified key
 * - OLD: noornote_mutes_browser, noornote_mutes_private_browser,
 *        noornote_muted_threads_browser, noornote_muted_threads_private_browser
 * - NEW: noornote_mutes_browser_v2 (MuteItem[])
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { MuteItem } from '../../types/BaseListItem';
import type { FetchFromRelaysResult } from '../sync/ListStorageAdapter';
import { migrateMuteStorage, needsMuteMigration, cleanupOldMuteStorage } from '../../types/BaseListItem';
import { GenericListOrchestrator } from './GenericListOrchestrator';
import { muteListConfig, createMuteFileStorageWrapper } from './configs/MuteListConfig';
import { EventBus } from '../EventBus';
import { ToastService } from '../ToastService';

export interface MuteStatus {
  public: boolean;
  private: boolean;
}

export class MuteOrchestrator extends GenericListOrchestrator<MuteItem> {
  private static instance: MuteOrchestrator;
  private featureFlagKey = 'noornote_nip51_private_mutes_enabled';
  private encryptionMethodKey = 'noornote_mute_list_encryption_method';
  private temporaryUnmutes: Set<string> = new Set();

  // In-memory cache for muted event IDs (for fast isThreadMuted checks)
  private mutedEventIds: Set<string> = new Set();
  private eventIdsCacheLoaded: boolean = false;

  private constructor() {
    super('MuteOrchestrator', muteListConfig, createMuteFileStorageWrapper());

    // Run migration if needed
    this.checkAndRunMigration();
  }

  public static getInstance(): MuteOrchestrator {
    if (!MuteOrchestrator.instance) {
      MuteOrchestrator.instance = new MuteOrchestrator();
    }
    return MuteOrchestrator.instance;
  }

  // Required Orchestrator abstract methods
  public override onui(_data: any): void {}
  public override onopen(_relay: string): void {}
  public override onmessage(_relay: string, _event: NostrEvent): void {}
  public override onerror(_relay: string, _error: Error): void {}
  public override onclose(_relay: string): void {}

  /**
   * Run one-time migration from old 4-key format to new unified format
   * IMPORTANT: Only runs when user is logged in, otherwise data would be lost!
   */
  private checkAndRunMigration(): void {
    // Don't run migration if no user - PerAccountLocalStorage.set() silently fails
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      // Schedule migration for when user logs in
      const eventBus = EventBus.getInstance();
      const handler = () => {
        this.runMigrationIfNeeded();
        eventBus.off('user:login', handler);
      };
      eventBus.on('user:login', handler);
      return;
    }

    this.runMigrationIfNeeded();
  }

  /**
   * Actually run the migration
   */
  private runMigrationIfNeeded(): void {
    if (needsMuteMigration()) {
      this.systemLogger.info('MuteOrchestrator', 'Running localStorage migration (4 keys → 1 key)...');

      const migratedItems = migrateMuteStorage();

      if (migratedItems.length > 0) {
        this.setBrowserItems(migratedItems);
        cleanupOldMuteStorage();

        this.systemLogger.info('MuteOrchestrator',
          `Migration complete: ${migratedItems.length} items migrated to unified format`
        );
      }
    }
  }

  /**
   * Check if NIP-51 private mutes feature is enabled
   */
  public isPrivateMutesEnabled(): boolean {
    try {
      const stored = localStorage.getItem(this.featureFlagKey);
      return stored === 'true';
    } catch {
      return false;
    }
  }

  /**
   * Enable/disable NIP-51 private mutes feature
   */
  public setPrivateMutesEnabled(enabled: boolean): void {
    try {
      localStorage.setItem(this.featureFlagKey, enabled.toString());
    } catch (error) {
      console.error('Failed to save NIP-51 private mutes flag:', error);
    }
  }

  /**
   * Get encryption method for private mutes (nip04 or nip44)
   */
  public getEncryptionMethod(): 'nip04' | 'nip44' {
    try {
      const stored = localStorage.getItem(this.encryptionMethodKey);
      if (stored === 'nip44') return 'nip44';
      return 'nip04'; // Default for Jumble compatibility
    } catch {
      return 'nip04';
    }
  }

  /**
   * Set encryption method for private mutes
   */
  public setEncryptionMethod(method: 'nip04' | 'nip44'): void {
    try {
      localStorage.setItem(this.encryptionMethodKey, method);
    } catch (error) {
      console.error('Failed to save encryption method:', error);
    }
  }

  // ===== User Muting Methods =====

  /**
   * Check if a user is muted
   * Reads from browserItems (localStorage)
   */
  public async isMuted(targetPubkey: string, _userPubkey?: string): Promise<MuteStatus> {
    if (this.temporaryUnmutes.has(targetPubkey)) {
      return { public: false, private: false };
    }

    try {
      const browserItems = this.getBrowserItems();

      // Find user mute items
      const publicMute = browserItems.find(
        item => item.type === 'user' && item.id === targetPubkey && !item.isPrivate
      );
      const privateMute = browserItems.find(
        item => item.type === 'user' && item.id === targetPubkey && item.isPrivate
      );

      return {
        public: !!publicMute,
        private: !!privateMute
      };
    } catch (error) {
      this.systemLogger.error('MuteOrchestrator', `Failed to check mute status: ${error}`);
      return { public: false, private: false };
    }
  }

  /**
   * Mute a user (public or private)
   * Writes to browserItems (localStorage)
   */
  public async muteUser(targetPubkey: string, isPrivate: boolean = false): Promise<boolean> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      throw new Error('User not authenticated');
    }

    try {
      // Check if already muted (same privacy level)
      const browserItems = this.getBrowserItems();
      const alreadyMuted = browserItems.some(
        item => item.type === 'user' && item.id === targetPubkey && item.isPrivate === isPrivate
      );

      if (alreadyMuted) {
        return true; // Already muted
      }

      // Create mute item
      const item: MuteItem = {
        id: targetPubkey,
        type: 'user',
        isPrivate,
        addedAt: Math.floor(Date.now() / 1000)
      };

      // Add via parent class
      await this.addItem(item);

      const muteType = isPrivate ? 'privately' : 'publicly';
      this.systemLogger.info('MuteOrchestrator', `Muted ${targetPubkey.slice(0, 8)}... ${muteType} (local)`);

      // Notify UI
      EventBus.getInstance().emit('mute:updated', { pubkey: targetPubkey });

      return true;
    } catch (error) {
      this.systemLogger.error('MuteOrchestrator', `Failed to mute user: ${error}`);
      throw error;
    }
  }

  /**
   * Unmute a user (removes from both public and private)
   * Writes to browserItems (localStorage)
   */
  public async unmuteUserCompletely(targetPubkey: string): Promise<boolean> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      throw new Error('User not authenticated');
    }

    try {
      // Remove all user mute items for this pubkey
      const browserItems = this.getBrowserItems();
      const updatedItems = browserItems.filter(
        item => !(item.type === 'user' && item.id === targetPubkey)
      );

      this.setBrowserItems(updatedItems);

      this.systemLogger.info('MuteOrchestrator', `Unmuted ${targetPubkey.slice(0, 8)}... (local)`);

      // Notify UI
      EventBus.getInstance().emit('mute:updated', { pubkey: targetPubkey });

      return true;
    } catch (error) {
      this.systemLogger.error('MuteOrchestrator', `Failed to unmute user: ${error}`);
      throw error;
    }
  }

  /**
   * Get all muted users (merged public + private)
   * Reads from browserItems (localStorage)
   */
  public async getAllMutedUsers(_pubkey?: string): Promise<string[]> {
    try {
      const browserItems = this.getBrowserItems();
      const userMutes = browserItems
        .filter(item => item.type === 'user')
        .map(item => item.id);

      return [...new Set(userMutes)]; // Deduplicate
    } catch (error) {
      this.systemLogger.error('MuteOrchestrator', `Failed to get all muted users: ${error}`);
      return [];
    }
  }

  /**
   * Get all muted users with their status (public/private/both)
   * Reads from browserItems (localStorage)
   */
  public async getAllMutedUsersWithStatus(_pubkey?: string): Promise<Map<string, MuteStatus>> {
    const result = new Map<string, MuteStatus>();

    try {
      const browserItems = this.getBrowserItems();

      // Filter user mutes only
      const userMutes = browserItems.filter(item => item.type === 'user');

      userMutes.forEach(item => {
        const existing = result.get(item.id);

        if (existing) {
          // Already exists, update status
          if (item.isPrivate) {
            existing.private = true;
          } else {
            existing.public = true;
          }
        } else {
          // New entry
          result.set(item.id, {
            public: !item.isPrivate,
            private: !!item.isPrivate
          });
        }
      });

      return result;
    } catch (error) {
      this.systemLogger.error('MuteOrchestrator', `Failed to fetch muted users with status: ${error}`);
      return result;
    }
  }

  // ===== Thread Muting Methods (Hell Thread Protection) =====

  /**
   * Load muted event IDs into memory cache
   * Called lazily on first thread mute check
   */
  private async ensureEventIdsCacheLoaded(): Promise<void> {
    if (this.eventIdsCacheLoaded) return;

    try {
      const browserItems = this.getBrowserItems();
      const threadMutes = browserItems
        .filter(item => item.type === 'thread')
        .map(item => item.id);

      this.mutedEventIds = new Set(threadMutes);
      this.eventIdsCacheLoaded = true;
    } catch (error) {
      this.systemLogger.error('MuteOrchestrator', `Failed to load muted event IDs: ${error}`);
      this.mutedEventIds = new Set();
      this.eventIdsCacheLoaded = true;
    }
  }

  /**
   * Mute a thread (stores event ID)
   * All replies to this note will be hidden
   */
  public async muteThread(eventId: string, isPrivate: boolean = false): Promise<boolean> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      throw new Error('User not authenticated');
    }

    try {
      // Check if already muted
      const browserItems = this.getBrowserItems();
      const alreadyMuted = browserItems.some(
        item => item.type === 'thread' && item.id === eventId && item.isPrivate === isPrivate
      );

      if (alreadyMuted) {
        return true; // Already muted
      }

      // Create mute item
      const item: MuteItem = {
        id: eventId,
        type: 'thread',
        isPrivate,
        addedAt: Math.floor(Date.now() / 1000)
      };

      // Add via parent class
      await this.addItem(item);

      // Update in-memory cache
      this.mutedEventIds.add(eventId);

      this.systemLogger.info('MuteOrchestrator',
        `Muted thread ${eventId.slice(0, 8)}... ${isPrivate ? 'privately' : 'publicly'} (local)`
      );

      // Notify UI
      EventBus.getInstance().emit('mute:thread:updated', { eventId });
      EventBus.getInstance().emit('mute:updated', {});

      return true;
    } catch (error) {
      this.systemLogger.error('MuteOrchestrator', `Failed to mute thread: ${error}`);
      throw error;
    }
  }

  /**
   * Unmute a thread (removes event ID from both lists)
   */
  public async unmuteThread(eventId: string): Promise<boolean> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      throw new Error('User not authenticated');
    }

    try {
      // Remove all thread mute items for this eventId
      const browserItems = this.getBrowserItems();
      const updatedItems = browserItems.filter(
        item => !(item.type === 'thread' && item.id === eventId)
      );

      this.setBrowserItems(updatedItems);

      // Update in-memory cache
      this.mutedEventIds.delete(eventId);

      this.systemLogger.info('MuteOrchestrator', `Unmuted thread ${eventId.slice(0, 8)}... (local)`);

      // Notify UI
      EventBus.getInstance().emit('mute:thread:updated', { eventId });
      EventBus.getInstance().emit('mute:updated', {});

      return true;
    } catch (error) {
      this.systemLogger.error('MuteOrchestrator', `Failed to unmute thread: ${error}`);
      throw error;
    }
  }

  /**
   * Check if a specific event ID is muted (simple check, no cascade)
   */
  public async isEventMuted(eventId: string): Promise<boolean> {
    await this.ensureEventIdsCacheLoaded();
    return this.mutedEventIds.has(eventId);
  }

  /**
   * Check if note or any of its parents/root are muted (cascading check)
   * Implements YakiHonne's Hell Thread protection logic
   */
  public async isThreadMuted(event: NostrEvent): Promise<boolean> {
    await this.ensureEventIdsCacheLoaded();

    // Check 1: Note itself muted
    if (this.mutedEventIds.has(event.id)) {
      return true;
    }

    // Check 2: Parent muted
    const parentId = this.extractParentId(event);
    if (parentId && this.mutedEventIds.has(parentId)) {
      return true;
    }

    // Check 3: Root muted
    const rootId = this.extractRootId(event);
    if (rootId && this.mutedEventIds.has(rootId)) {
      return true;
    }

    return false;
  }

  /**
   * Get all muted event IDs (merged public + private)
   */
  public async getAllMutedEventIds(): Promise<string[]> {
    try {
      const browserItems = this.getBrowserItems();
      const threadMutes = browserItems
        .filter(item => item.type === 'thread')
        .map(item => item.id);

      return [...new Set(threadMutes)]; // Deduplicate
    } catch (error) {
      this.systemLogger.error('MuteOrchestrator', `Failed to get all muted event IDs: ${error}`);
      return [];
    }
  }

  /**
   * Get all muted threads with their status (public/private)
   */
  public async getAllMutedThreadsWithStatus(): Promise<Map<string, MuteStatus>> {
    const result = new Map<string, MuteStatus>();

    try {
      const browserItems = this.getBrowserItems();

      // Filter thread mutes only
      const threadMutes = browserItems.filter(item => item.type === 'thread');

      threadMutes.forEach(item => {
        const existing = result.get(item.id);

        if (existing) {
          // Already exists, update status
          if (item.isPrivate) {
            existing.private = true;
          } else {
            existing.public = true;
          }
        } else {
          // New entry
          result.set(item.id, {
            public: !item.isPrivate,
            private: !!item.isPrivate
          });
        }
      });

      return result;
    } catch (error) {
      this.systemLogger.error('MuteOrchestrator', `Failed to fetch muted threads with status: ${error}`);
      return result;
    }
  }

  // ===== NIP-10 Thread Tag Helpers =====

  /**
   * Extract root event ID from e-tags (NIP-10)
   */
  private extractRootId(event: NostrEvent): string | null {
    const eTags = event.tags.filter(tag => tag[0] === 'e');
    if (eTags.length === 0) return null;

    // NIP-10: Look for explicit "root" marker
    const rootTag = eTags.find(tag => tag[3] === 'root');
    if (rootTag) return rootTag[1];

    // NIP-10 deprecated positional: first e-tag is root (only if multiple)
    if (eTags.length > 1) return eTags[0][1];

    return null;
  }

  /**
   * Extract parent event ID from e-tags (NIP-10)
   */
  private extractParentId(event: NostrEvent): string | null {
    const eTags = event.tags.filter(tag => tag[0] === 'e');
    if (eTags.length === 0) return null;

    // NIP-10: Look for explicit "reply" marker
    const replyTag = eTags.find(tag => tag[3] === 'reply');
    if (replyTag) return replyTag[1];

    // NIP-10 deprecated positional
    if (eTags.length === 1) return eTags[0][1];
    return eTags[eTags.length - 1][1]; // Last e-tag = parent
  }

  // ===== Relay Sync Methods =====

  /**
   * Fetch mutes from relays (read-only, no local changes)
   * Returns merged public + private mutes (users only for backward compat)
   * Returns FetchFromRelaysResult with relayContentWasEmpty flag
   */
  public async fetchMutesFromRelays(): Promise<FetchFromRelaysResult<string>> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      return { items: [], relayContentWasEmpty: true };
    }

    try {
      const relays = this.getBootstrapRelays();
      const events = await this.transport.fetch(relays, [{
        authors: [currentUser.pubkey],
        kinds: [10000],
        limit: 10
      }], 5000);

      // Fetch deletion events (kind:5) to filter out deleted mute lists
      const deletionEvents = await this.transport.fetch(relays, [{
        authors: [currentUser.pubkey],
        kinds: [5]
      }], 5000);

      // Extract deleted coordinate with deletion timestamp
      // NIP-09: For replaceable events, delete "all versions up to the deletion event timestamp"
      let deletionTimestamp: number | undefined;
      deletionEvents.forEach(deletionEvent => {
        deletionEvent.tags
          .filter(t => t[0] === 'a' && t[1]?.startsWith('10000:'))
          .forEach(t => {
            const coordinate = t[1];
            const expectedCoordinate = `10000:${currentUser.pubkey}`;
            if (coordinate === expectedCoordinate) {
              // Keep newest deletion timestamp if multiple deletions exist
              if (!deletionTimestamp || deletionEvent.created_at > deletionTimestamp) {
                deletionTimestamp = deletionEvent.created_at;
              }
            }
          });
      });

      // Filter out deleted events (events older than deletion timestamp)
      let validEvents = events;
      if (deletionTimestamp !== undefined) {
        validEvents = events.filter(event => event.created_at >= deletionTimestamp);
        const filteredCount = events.length - validEvents.length;
        if (filteredCount > 0) {
          this.systemLogger.info('MuteOrchestrator',
            `Filtered out ${filteredCount} deleted mute list(s) (older than deletion at ${deletionTimestamp})`
          );
        }
      }

      if (validEvents.length === 0) {
        this.systemLogger.info('MuteOrchestrator', 'No remote mute list found');
        return { items: [], relayContentWasEmpty: true };
      }

      // Get newest event
      const remoteEvent = validEvents.sort((a, b) => b.created_at - a.created_at)[0];

      // Check if content was empty (mixed-client edge case - see LIST-MANAGEMENT-SPEC.md)
      const relayContentWasEmpty = !remoteEvent.content || remoteEvent.content.trim() === '';

      // Extract remote public mutes (users only)
      const remotePublicMutes = remoteEvent.tags
        .filter(tag => tag[0] === 'p' && tag[1])
        .map(tag => tag[1]);

      // Extract remote private mutes (if enabled)
      let remotePrivateMutes: string[] = [];
      if (this.isPrivateMutesEnabled() && remoteEvent.content && !relayContentWasEmpty) {
        const decrypted = await this.decryptPrivateItems(remoteEvent, currentUser.pubkey);
        remotePrivateMutes = decrypted
          .filter(item => item.type === 'user')
          .map(item => item.id);
      }

      // Merge and return
      return {
        items: [...new Set([...remotePublicMutes, ...remotePrivateMutes])],
        relayContentWasEmpty
      };
    } catch (error) {
      this.systemLogger.error('MuteOrchestrator', `Failed to fetch from relays: ${error}`);
      return { items: [], relayContentWasEmpty: true };
    }
  }

  /**
   * Sync mute list from relays with smart merge
   */
  public override async syncFromRelays(options: { autoRepublish?: boolean } = {}): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      return;
    }

    try {
      const relays = this.getBootstrapRelays();
      const events = await this.transport.fetch(relays, [{
        authors: [currentUser.pubkey],
        kinds: [10000],
        limit: 10
      }], 5000);

      // Fetch deletion events (kind:5) to filter out deleted mute lists
      const deletionEvents = await this.transport.fetch(relays, [{
        authors: [currentUser.pubkey],
        kinds: [5]
      }], 5000);

      // Extract deleted coordinate with deletion timestamp
      // NIP-09: For replaceable events, delete "all versions up to the deletion event timestamp"
      let deletionTimestamp: number | undefined;
      deletionEvents.forEach(deletionEvent => {
        deletionEvent.tags
          .filter(t => t[0] === 'a' && t[1]?.startsWith('10000:'))
          .forEach(t => {
            const coordinate = t[1];
            const expectedCoordinate = `10000:${currentUser.pubkey}`;
            if (coordinate === expectedCoordinate) {
              if (!deletionTimestamp || deletionEvent.created_at > deletionTimestamp) {
                deletionTimestamp = deletionEvent.created_at;
              }
            }
          });
      });

      // Filter out deleted events (events older than deletion timestamp)
      let validEvents = events;
      if (deletionTimestamp !== undefined) {
        validEvents = events.filter(event => event.created_at >= deletionTimestamp);
        const filteredCount = events.length - validEvents.length;
        if (filteredCount > 0) {
          this.systemLogger.info('MuteOrchestrator',
            `Filtered out ${filteredCount} deleted mute list(s) (older than deletion at ${deletionTimestamp})`
          );
        }
      }

      if (validEvents.length === 0) {
        this.systemLogger.info('MuteOrchestrator', 'No remote mute list found');
        return;
      }

      // Get newest event
      const remoteEvent = validEvents.sort((a, b) => b.created_at - a.created_at)[0];

      // Get local browser storage
      const localItems = this.getBrowserItems();

      // Extract remote items (users + threads)
      const remoteTags: string[][] = [];

      // Public mutes from tags
      remoteEvent.tags.forEach(tag => {
        if ((tag[0] === 'p' || tag[0] === 'e') && tag[1]) {
          remoteTags.push(tag);
        }
      });

      // Private mutes from content
      if (remoteEvent.content) {
        const decryptedItems = await this.decryptPrivateItems(remoteEvent, currentUser.pubkey);
        decryptedItems.forEach(item => {
          const tagType = item.type === 'user' ? 'p' : 'e';
          remoteTags.push([tagType, item.id]);
        });
      }

      // Convert remote tags to MuteItems
      const remoteItems: MuteItem[] = remoteTags.map(tag => ({
        id: tag[1],
        type: tag[0] === 'p' ? 'user' : 'thread',
        addedAt: remoteEvent.created_at
      }));

      // Count new items
      const localIds = new Set(localItems.map(item => `${item.type}:${item.id}`));
      const newItems = remoteItems.filter(
        item => !localIds.has(`${item.type}:${item.id}`)
      );

      // Merge (union)
      const merged = this.mergeItems(localItems, remoteItems);

      // Update browser storage
      this.setBrowserItems(merged);

      // Update in-memory cache
      this.mutedEventIds = new Set(
        merged.filter(item => item.type === 'thread').map(item => item.id)
      );
      this.eventIdsCacheLoaded = true;

      // Notify user
      if (newItems.length > 0) {
        const userCount = newItems.filter(i => i.type === 'user').length;
        const threadCount = newItems.filter(i => i.type === 'thread').length;
        const parts: string[] = [];
        if (userCount > 0) parts.push(`${userCount} user${userCount > 1 ? 's' : ''}`);
        if (threadCount > 0) parts.push(`${threadCount} thread${threadCount > 1 ? 's' : ''}`);
        ToastService.show(`Merged ${parts.join(' + ')} from relays`, 'success');
        this.systemLogger.info('MuteOrchestrator', `✓ Merged ${newItems.length} new mutes`);
      } else {
        this.systemLogger.info('MuteOrchestrator', `✓ Synced from relays (no new mutes)`);
      }

      // Notify UI
      EventBus.getInstance().emit('mute:updated', {});

      // Optional: Auto-republish
      if (options.autoRepublish && newItems.length > 0) {
        this.systemLogger.info('MuteOrchestrator', 'Auto-republishing merged mute list...');
        await this.publishToRelays();
      }
    } catch (error) {
      this.systemLogger.error('MuteOrchestrator', `Failed to sync from relays: ${error}`);
    }
  }

  /**
   * Republish current mute list to relays
   */
  public async republishCurrentMuteList(): Promise<void> {
    await this.publishToRelays();
  }

  // ===== Temporary Unmutes =====

  /**
   * Temporarily unmute a user (until app restart)
   */
  public temporarilyUnmute(pubkey: string): void {
    this.temporaryUnmutes.add(pubkey);
    EventBus.getInstance().emit('mute:updated', { pubkey });
  }

  /**
   * Re-mute a temporarily unmuted user
   */
  public revertTemporaryUnmute(pubkey: string): void {
    this.temporaryUnmutes.delete(pubkey);
    EventBus.getInstance().emit('mute:updated', { pubkey });
  }

  /**
   * Get file paths for debugging
   */
  public getFilePaths(): { public: string | null; private: string | null } {
    return {
      public: '~/.noornote/mutes-public.json',
      private: '~/.noornote/mutes-private.json'
    };
  }
}
