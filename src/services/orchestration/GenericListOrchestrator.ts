/**
 * @orchestrator GenericListOrchestrator
 * @purpose Generic list management with config-driven behavior
 * @used-by FollowListOrchestrator, MuteOrchestrator, BookmarkOrchestrator
 *
 * Architecture:
 * ┌─────────────────────────────────────────────────────────┐
 * │                Browser (localStorage)                   │
 * │           SINGLE SOURCE OF TRUTH                        │
 * └──────────────┬──────────────────────────────────────────┘
 *                │
 *     ┌──────────┼──────────┐
 *     │          │          │
 *     ▼          ▼          ▼
 * ┌────────┐ ┌──────┐ ┌─────────┐
 * │ Files  │ │  UI  │ │ Relays  │
 * └────────┘ └──────┘ └─────────┘
 *
 * All changes happen ONLY in Browser (localStorage).
 * Use "Save to File" or "Sync to Relays" to persist elsewhere.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { BaseListItem } from '../../types/BaseListItem';
import type { ListConfig, FileStorageWrapper } from '../../types/ListConfig';
import type { FetchFromRelaysResult } from '../sync/ListStorageAdapter';
import { Orchestrator } from './Orchestrator';
import { NostrTransport } from '../transport/NostrTransport';
import { AuthService } from '../AuthService';
import { RelayConfig } from '../RelayConfig';
import { SystemLogger } from '../../components/system/SystemLogger';
import { EventBus } from '../EventBus';
import { PerAccountLocalStorage } from '../PerAccountLocalStorage';

export class GenericListOrchestrator<T extends BaseListItem> extends Orchestrator {
  protected transport: NostrTransport;
  protected authService: AuthService;
  protected relayConfig: RelayConfig;
  protected systemLogger: SystemLogger;
  protected eventBus: EventBus;
  protected config: ListConfig<T>;
  protected fileStorage: FileStorageWrapper<T>;

  constructor(
    name: string,
    config: ListConfig<T>,
    fileStorage: FileStorageWrapper<T>
  ) {
    super(name);
    this.transport = NostrTransport.getInstance();
    this.authService = AuthService.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.eventBus = EventBus.getInstance();
    this.config = config;
    this.fileStorage = fileStorage;
  }

  // Required Orchestrator abstract methods
  public onui(_data: any): void {}
  public onopen(_relay: string): void {}
  public onmessage(_relay: string, _event: NostrEvent): void {}
  public onerror(_relay: string, _error: Error): void {}
  public onclose(_relay: string): void {}

  // ===== Browser Storage (Single Source of Truth) =====

  /**
   * Get items from browser storage (per-account or legacy global)
   * CLAUDE.md Rule: Browser is single source of truth
   */
  public getBrowserItems(): T[] {
    try {
      // Use per-account storage if configured (preferred)
      if (this.config.perAccountStorageKey) {
        const storage = PerAccountLocalStorage.getInstance();
        return storage.get<T[]>(this.config.perAccountStorageKey, []);
      }

      // Fallback: Legacy global storage
      const stored = localStorage.getItem(this.config.browserStorageKey);
      if (!stored) return [];
      return JSON.parse(stored);
    } catch (error) {
      this.systemLogger.error(this.name, `Failed to read browser items: ${error}`);
      return [];
    }
  }

  /**
   * Set items in browser storage (per-account or legacy global)
   * CLAUDE.md Rule: ALL changes happen ONLY in Browser
   */
  public setBrowserItems(items: T[]): void {
    try {
      const uniqueItems = this.deduplicateItems(items);

      // Use per-account storage if configured (preferred)
      if (this.config.perAccountStorageKey) {
        const storage = PerAccountLocalStorage.getInstance();
        storage.set(this.config.perAccountStorageKey, uniqueItems);
        return;
      }

      // Fallback: Legacy global storage
      localStorage.setItem(this.config.browserStorageKey, JSON.stringify(uniqueItems));
    } catch (error) {
      this.systemLogger.error(this.name, `Failed to write browser items: ${error}`);
      throw error;
    }
  }

  /**
   * Deduplicate items by unique ID
   */
  protected deduplicateItems(items: T[]): T[] {
    const map = new Map<string, T>();
    items.forEach(item => map.set(this.config.getItemId(item), item));
    return Array.from(map.values());
  }

  // ===== Item Operations (Browser-only) =====

  /**
   * Add item to browser storage (NO relay publish)
   * Use "Sync to Relays" button to publish
   */
  public async addItem(item: T): Promise<void> {
    const browserItems = this.getBrowserItems();

    // Check if already exists
    const itemId = this.config.getItemId(item);
    if (browserItems.some(i => this.config.getItemId(i) === itemId)) {
      return; // Already exists
    }

    // Add to browser storage
    browserItems.push(item);
    this.setBrowserItems(browserItems);

    const privateStatus = item.isPrivate ? 'private' : 'public';
    this.systemLogger.info(this.name, `Added ${privateStatus} item (browser): ${itemId.slice(0, 8)}...`);
  }

  /**
   * Remove item from browser storage (NO relay publish)
   * Use "Sync to Relays" button to publish changes
   */
  public async removeItem(itemId: string): Promise<void> {
    const browserItems = this.getBrowserItems();

    // Remove from browser storage
    const updatedItems = browserItems.filter(item => this.config.getItemId(item) !== itemId);
    this.setBrowserItems(updatedItems);

    this.systemLogger.info(this.name, `Removed item (browser): ${itemId.slice(0, 8)}...`);
  }

  /**
   * Get all items with their status (public/private/both)
   * Returns a map of itemId -> { public: boolean, private: boolean }
   */
  public async getAllItemsWithStatus(): Promise<Map<string, { public: boolean; private: boolean }>> {
    const result = new Map<string, { public: boolean; private: boolean }>();

    try {
      const browserItems = this.getBrowserItems();

      // Categorize by isPrivate flag
      browserItems.forEach(item => {
        const itemId = this.config.getItemId(item);
        if (item.isPrivate) {
          result.set(itemId, { public: false, private: true });
        } else {
          result.set(itemId, { public: true, private: false });
        }
      });

      return result;
    } catch (error) {
      this.systemLogger.error(this.name, `Failed to get items with status: ${error}`);
      return result;
    }
  }

  // ===== Relay Operations =====

  /**
   * Publish to relays (manual sync via UI button)
   * Reads from BROWSER storage and publishes to relays
   *
   * NIP-51 COMPLIANT: ONE event with:
   * - tags: public items
   * - content: encrypted private items (or '' if none)
   *
   * Reference: docs/features/LIST-MANAGEMENT-SPEC.md
   */
  public async publishToRelays(): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      throw new Error('User not authenticated');
    }

    const writeRelays = this.transport.getWriteRelays();
    if (writeRelays.length === 0) {
      throw new Error('No write relays available');
    }

    // Read from browser storage
    const browserItems = this.getBrowserItems();

    // Separate public and private items
    const publicItems = browserItems.filter(item => !item.isPrivate);
    const privateItems = browserItems.filter(item => item.isPrivate);

    // Build public tags
    const publicTags = publicItems.flatMap(item => this.config.itemToTags(item));

    // Build encrypted content for private items
    // Use custom encryption if provided in config, otherwise use default
    let encryptedContent = '';
    if (privateItems.length > 0) {
      if (this.config.encryptPrivateItems) {
        encryptedContent = await this.config.encryptPrivateItems(privateItems, currentUser.pubkey);
      } else {
        encryptedContent = await this.encryptPrivateItems(privateItems, currentUser.pubkey);
      }
    }

    // Create ONE event with both public tags AND encrypted private content
    const event = {
      kind: this.config.publicEventKind,
      created_at: Math.floor(Date.now() / 1000),
      tags: publicTags,
      content: encryptedContent,
      pubkey: currentUser.pubkey
    };

    const signed = await this.authService.signEvent(event);

    if (!signed) {
      throw new Error(`Failed to sign ${this.config.name} event`);
    }

    await this.transport.publish(writeRelays, signed);

    this.systemLogger.info(this.name,
      `Published to relays: ${publicItems.length} public + ${privateItems.length} private (ONE event)`
    );
  }

  /**
   * Default encryption: Convert items to tags, then encrypt as JSON
   * Supports NIP-44 with NIP-04 fallback
   */
  protected async encryptPrivateItems(items: T[], pubkey: string): Promise<string> {
    const tags = items.flatMap(item => this.config.itemToTags(item));
    const plaintext = JSON.stringify(tags);
    const authMethod = this.authService.getAuthMethod();

    if (authMethod === 'key-signer') {
      const { KeySignerClient } = await import('../KeySignerClient');
      const keySignerClient = KeySignerClient.getInstance();
      try {
        return await keySignerClient.nip44Encrypt(plaintext, pubkey);
      } catch {
        return await keySignerClient.nip04Encrypt(plaintext, pubkey);
      }
    } else if (authMethod === 'nip46') {
      const nip46Manager = (this.authService as any).nip46Manager;
      if (!nip46Manager?.isAvailable()) {
        throw new Error('NIP-46 remote signer not available');
      }
      // Add timeout for NIP-46 RPC operations (remote signer may not respond)
      const encryptWithTimeout = <R>(fn: () => Promise<R>, timeoutMs: number = 15000): Promise<R> => {
        return Promise.race([
          fn(),
          new Promise<R>((_, reject) =>
            setTimeout(() => reject(new Error('NIP-46 encrypt timeout')), timeoutMs)
          )
        ]);
      };
      try {
        return await encryptWithTimeout(() => nip46Manager.nip44Encrypt(plaintext, pubkey));
      } catch {
        return await encryptWithTimeout(() => nip46Manager.nip04Encrypt(plaintext, pubkey));
      }
    } else if (authMethod === 'extension') {
      try {
        if (window.nostr?.nip44?.encrypt) {
          return await window.nostr.nip44.encrypt(pubkey, plaintext);
        } else {
          throw new Error('NIP-44 not available');
        }
      } catch {
        if (window.nostr?.nip04?.encrypt) {
          return await window.nostr.nip04.encrypt(pubkey, plaintext);
        } else {
          throw new Error('No encryption support available in browser extension');
        }
      }
    } else if (authMethod === 'nsec') {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser?.privateKey) {
        throw new Error('No private key available for encryption');
      }
      const { nip04 } = await import('../NostrToolsAdapter');
      return await nip04.encrypt(currentUser.privateKey, pubkey, plaintext);
    } else {
      throw new Error(`Auth method not supported for encryption: ${authMethod}`);
    }
  }

  /**
   * Fetch items from relays (read-only, no local changes)
   * Returns merged public + private items from ONE event
   *
   * NIP-51 COMPLIANT: ONE event contains:
   * - tags: public items
   * - content: encrypted private items
   *
   * Returns FetchFromRelaysResult with:
   * - items: merged public + private items
   * - relayContentWasEmpty: true if content was empty (mixed-client edge case)
   */
  public async fetchFromRelays(pubkey: string): Promise<FetchFromRelaysResult<T>> {
    const relays = this.getBootstrapRelays();

    try {
      // Fetch ONE event (contains both public tags and encrypted private content)
      const events = await this.transport.fetch(relays, [{
        authors: [pubkey],
        kinds: [this.config.publicEventKind],
        limit: 1
      }], 5000);

      if (events.length === 0) {
        this.systemLogger.info(this.name, 'No remote list found');
        return { items: [], relayContentWasEmpty: true };
      }

      const event = events[0];

      // Check if content was empty (mixed-client edge case - see LIST-MANAGEMENT-SPEC.md)
      const relayContentWasEmpty = !event.content || event.content.trim() === '';

      // Extract public items from tags
      const publicItems = this.config.tagsToItem(event.tags, event.created_at);
      // Mark as public
      publicItems.forEach(item => { item.isPrivate = false; });

      // Extract private items from encrypted content
      let privateItems: T[] = [];
      let decryptionFailed = false;
      if (!relayContentWasEmpty) {
        try {
          privateItems = await this.decryptPrivateItems(event, pubkey);
          // Mark as private
          privateItems.forEach(item => { item.isPrivate = true; });
          // Check if decryption returned empty despite content existing (e.g., hardware signer can't decrypt)
          if (privateItems.length === 0) {
            decryptionFailed = true;
          }
        } catch (error) {
          this.systemLogger.error(this.name, `Could not decrypt private items: ${error}`);
          decryptionFailed = true;
        }
      }

      // Merge (deduplicate by ID)
      const itemMap = new Map<string, T>();
      publicItems.forEach(item => itemMap.set(this.config.getItemId(item), item));
      privateItems.forEach(item => itemMap.set(this.config.getItemId(item), item));

      return {
        items: Array.from(itemMap.values()),
        relayContentWasEmpty,
        decryptionFailed
      };
    } catch (error) {
      this.systemLogger.error(this.name, `Failed to fetch from relays: ${error}`);
      return { items: [], relayContentWasEmpty: true };
    }
  }

  /**
   * Default decryption: Decrypt content, parse as tags, convert to items
   * Supports NIP-44 with NIP-04 fallback
   */
  protected async decryptPrivateItems(event: NostrEvent, pubkey: string): Promise<T[]> {
    if (!event.content || event.content.trim() === '') {
      return [];
    }

    // Use custom decryption if provided
    if (this.config.decryptPrivateItems) {
      return await this.config.decryptPrivateItems(event.content, pubkey);
    }

    try {
      let plaintext: string | null = null;
      const authMethod = this.authService.getAuthMethod();

      if (authMethod === 'key-signer') {
        const { KeySignerClient } = await import('../KeySignerClient');
        const keySignerClient = KeySignerClient.getInstance();
        try {
          plaintext = await keySignerClient.nip44Decrypt(event.content, event.pubkey);
        } catch {
          plaintext = await keySignerClient.nip04Decrypt(event.content, event.pubkey);
        }
      } else if (authMethod === 'nip46') {
        const nip46Manager = (this.authService as any).nip46Manager;
        if (!nip46Manager?.isAvailable()) {
          throw new Error('NIP-46 remote signer not available');
        }
        // Add timeout for NIP-46 RPC operations (remote signer may not respond)
        const decryptWithTimeout = <R>(fn: () => Promise<R>, timeoutMs: number = 10000): Promise<R> => {
          return Promise.race([
            fn(),
            new Promise<R>((_, reject) =>
              setTimeout(() => reject(new Error('NIP-46 decrypt timeout')), timeoutMs)
            )
          ]);
        };
        try {
          plaintext = await decryptWithTimeout(() => nip46Manager.nip44Decrypt(event.content, event.pubkey));
        } catch {
          plaintext = await decryptWithTimeout(() => nip46Manager.nip04Decrypt(event.content, event.pubkey));
        }
      } else if (authMethod === 'extension') {
        if (window.nostr?.nip44?.decrypt) {
          try {
            plaintext = await window.nostr.nip44.decrypt(event.pubkey, event.content);
          } catch {}
        }
        if (!plaintext && window.nostr?.nip04?.decrypt) {
          plaintext = await window.nostr.nip04.decrypt(event.pubkey, event.content);
        }
      } else if (authMethod === 'nsec') {
        const currentUser = this.authService.getCurrentUser();
        if (!currentUser?.privateKey) {
          throw new Error('No private key available for decryption');
        }
        const { nip04 } = await import('../NostrToolsAdapter');
        plaintext = await nip04.decrypt(currentUser.privateKey, event.pubkey, event.content);
      }

      if (!plaintext) {
        throw new Error('Decryption failed');
      }

      const tags: string[][] = JSON.parse(plaintext);
      return this.config.tagsToItem(tags, event.created_at);
    } catch (error) {
      this.systemLogger.error(this.name, `Failed to decrypt private items: ${error}`);
      return [];
    }
  }

  /**
   * Sync from relays (manual sync)
   * Fetches from relays, merges with local browser storage
   *
   * Merge Strategy:
   * - Union of remote + local items
   * - Only updates if remote has newer items
   */
  public async syncFromRelays(pubkey: string): Promise<{ added: number; total: number }> {
    const relays = this.getBootstrapRelays();
    this.systemLogger.info(this.name, `Syncing from relays (${relays.length} relays)...`);

    try {
      // Fetch from relays
      const fetchResult = await this.fetchFromRelays(pubkey);

      // Read local browser storage
      const localItems = this.getBrowserItems();

      // Merge (union)
      const merged = this.mergeItems(localItems, fetchResult.items);

      // Count newly added
      const added = merged.length - localItems.length;

      // Update browser storage
      this.setBrowserItems(merged);

      this.systemLogger.info(this.name,
        `Sync complete: ${added} new items added (${merged.length} total)`
      );

      return {
        added,
        total: merged.length
      };
    } catch (error) {
      this.systemLogger.error(this.name, `Sync from relays failed: ${error}`);
      throw error;
    }
  }

  /**
   * Merge two item lists (union, preserve metadata)
   */
  protected mergeItems(local: T[], remote: T[]): T[] {
    const map = new Map<string, T>();

    // Add local items
    local.forEach(item => map.set(this.config.getItemId(item), item));

    // Add/update with remote items (prefer remote if newer)
    remote.forEach(item => {
      const itemId = this.config.getItemId(item);
      const existing = map.get(itemId);
      if (!existing || (item.addedAt && existing.addedAt && item.addedAt > existing.addedAt)) {
        map.set(itemId, item);
      }
    });

    return Array.from(map.values());
  }

  // ===== File Operations =====

  /**
   * Save browser items to files
   * Reads from BROWSER storage and writes to files
   */
  public async saveToFile(): Promise<void> {
    const browserItems = this.getBrowserItems();

    // Separate public and private
    const publicItems = browserItems.filter(item => !item.isPrivate);
    const privateItems = browserItems.filter(item => item.isPrivate);

    const timestamp = Math.floor(Date.now() / 1000);

    await this.fileStorage.writePublic({
      items: publicItems,
      lastModified: timestamp
    });

    await this.fileStorage.writePrivate({
      items: privateItems,
      lastModified: timestamp
    });

    this.systemLogger.info(this.name,
      `Saved to files: ${publicItems.length} public, ${privateItems.length} private`
    );
  }

  /**
   * Restore items from files to browser storage
   * Reads from FILES and writes to browser
   */
  public async restoreFromFile(): Promise<void> {
    const allItems = await this.fileStorage.getAllItems();
    this.setBrowserItems(allItems);

    this.systemLogger.info(this.name,
      `Restored ${allItems.length} items from files to browser`
    );
  }

  // ===== Helpers =====

  /**
   * Get bootstrap relays for fetching
   */
  protected getBootstrapRelays(): string[] {
    return this.relayConfig.getAggregatorRelays();
  }
}
