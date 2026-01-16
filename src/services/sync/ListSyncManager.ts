/**
 * @service ListSyncManager
 * @purpose Generic list synchronization manager for Browser ↔ File ↔ Relays
 * @used-by BookmarkOrchestrator, FollowListOrchestrator, MuteOrchestrator (and future list types)
 *
 * Storage Locations:
 * - Browser: localStorage/indexedDB (runtime)
 * - File: ~/.noornote/*.json (persistent local)
 * - Relays: User's write-relays (remote)
 *
 * Operations (ALL triggered by user button-click, NO auto-sync):
 * 1. Sync from Relays → Relay → Browser (with conflict check)
 * 2. Sync to Relays → Browser → Relay (always overwrite)
 * 3. Save to local file → Browser → File (always overwrite)
 * 4. Restore from local file → File → Browser
 *
 * EDGE CASE: Mixed-client private item handling
 * See docs/features/LIST-MANAGEMENT-SPEC.md for details
 */

import type { ListStorageAdapter, SyncDiff } from './ListStorageAdapter';
import { PlatformService } from '../PlatformService';

export type SyncStrategy = 'merge' | 'overwrite';

export interface SyncFromRelaysResult<T> {
  requiresConfirmation: boolean;
  diff: SyncDiff<T>;
  relayItems: T[];
  /** True if relay event content was empty (another client may have overwritten) */
  relayContentWasEmpty: boolean;
  /** Category assignments from relay (bookmarkId -> categoryName) - for Bookmarks */
  categoryAssignments?: Map<string, string>;
  /** Category names (d-tags) found on relays - for Bookmarks */
  categories?: string[];
}

export interface SyncFromFileResult<T> {
  requiresConfirmation: boolean;
  diff: SyncDiff<T>;
  fileItems: T[];
}

export class ListSyncManager<T> {
  constructor(private adapter: ListStorageAdapter<T>) {}

  /**
   * Button 1: "Sync from Relays"
   *
   * Phase 1: Fetch + Compare (NO changes to browser storage yet)
   * - Fetches list from relays
   * - Compares with current browser list
   * - Returns diff and whether user confirmation is needed
   *
   * Rules:
   * - Browser has MORE items than relay → requiresConfirmation = true
   * - Browser has LESS items than relay → requiresConfirmation = false (auto-merge)
   *
   * EDGE CASE: If relay content was empty, private items are excluded from "removed"
   * (another client without private support may have overwritten - see spec)
   *
   * Phase 2: Apply (call applySyncFromRelays() after user decision)
   */
  async syncFromRelays(): Promise<SyncFromRelaysResult<T>> {
    // Fetch from relays (NO changes to browser yet)
    const fetchResult = await this.adapter.fetchFromRelays();
    const relayItems = fetchResult.items;
    const relayContentWasEmpty = fetchResult.relayContentWasEmpty;
    const decryptionFailed = fetchResult.decryptionFailed || false;
    const browserItems = this.adapter.getBrowserItems();

    // Calculate diff - preserve private items if content was empty OR decryption failed
    // (e.g., hardware signer can't decrypt, but private items still exist on relay)
    const preservePrivateItems = relayContentWasEmpty || decryptionFailed;
    const diff = this.calculateDiff(browserItems, relayItems, preservePrivateItems);

    // Determine if confirmation is needed
    // Browser has more items (removed.length > 0) → needs confirmation
    const requiresConfirmation = diff.removed.length > 0;

    const result: SyncFromRelaysResult<T> = {
      requiresConfirmation,
      diff,
      relayItems,
      relayContentWasEmpty: preservePrivateItems // Use combined flag for downstream handling
    };
    if (fetchResult.categoryAssignments) {
      result.categoryAssignments = fetchResult.categoryAssignments;
    }
    if (fetchResult.categories) {
      result.categories = fetchResult.categories;
    }
    return result;
  }

  /**
   * Phase 2 of "Sync from Relays"
   * Called AFTER user decision in confirmation modal
   *
   * @param strategy 'merge' = keep local items + add new from relay
   *                 'overwrite' = replace browser with relay (accept deletions)
   * @param relayItems The items fetched from relays (from syncFromRelays result)
   * @param relayContentWasEmpty If true, preserve local private items even on overwrite
   */
  async applySyncFromRelays(strategy: SyncStrategy, relayItems: T[], relayContentWasEmpty: boolean = false): Promise<void> {
    const browserItems = this.adapter.getBrowserItems();

    if (strategy === 'overwrite') {
      if (relayContentWasEmpty) {
        // Relay content was empty - another client without private support may have overwritten
        // Preserve local private items even when user chose "overwrite"
        const localPrivateItems = browserItems.filter(item => (item as any).isPrivate === true);
        this.adapter.setBrowserItems([...relayItems, ...localPrivateItems]);
      } else {
        // Relay content had encrypted data - trust relay completely
        this.adapter.setBrowserItems(relayItems);
      }
    } else {
      // User clicked "Keep them" → merge (union: keep all browser + add new from relay)
      const merged = this.mergeItems(browserItems, relayItems);
      this.adapter.setBrowserItems(merged);
    }
  }

  /**
   * Button 2: "Sync to Relays"
   *
   * Browser → Relays (always overwrite)
   * No confirmation needed, user explicitly requested overwrite
   */
  async syncToRelays(): Promise<void> {
    const browserItems = this.adapter.getBrowserItems();
    await this.adapter.publishToRelays(browserItems);
  }

  /**
   * Button 3: "Save to local file"
   *
   * Browser → File (always overwrite)
   * - Tauri: Write to ~/.noornote/*.json
   * - Browser: Download as JSON file
   */
  async saveToFile(listTypeName?: string): Promise<void> {
    const browserItems = this.adapter.getBrowserItems();

    if (PlatformService.getInstance().isTauri) {
      // Tauri: Use native file storage
      await this.adapter.setFileItems(browserItems);
    } else {
      // Browser: Download as JSON
      this.downloadAsJson(browserItems, listTypeName || 'list');
    }
  }

  /**
   * Restore folder data from file (if adapter supports it)
   * Only applicable to lists with folder organization (Bookmarks, Tribes)
   *
   * Should be called BEFORE restoreFromFile() to ensure folder structure exists
   */
  async restoreFolderDataFromFile(): Promise<void> {
    if (this.adapter.restoreFolderDataFromFile) {
      await this.adapter.restoreFolderDataFromFile();
    }
  }

  /**
   * Button 4: "Restore from local file" - Phase 1
   *
   * File → Browser (with conflict detection)
   * - Reads file and compares with browser
   * - Returns diff for confirmation modal if browser would lose items
   *
   * Similar to syncFromRelays() pattern
   */
  async syncFromFile(): Promise<SyncFromFileResult<T>> {
    // NOTE: Do NOT restore folder data here - it would overwrite browser
    // folder assignments before user decides merge vs overwrite.
    // Folder data is restored in applySyncFromFile() for 'overwrite' only.

    const fileItems = await this.adapter.getFileItems();
    const browserItems = this.adapter.getBrowserItems();

    // Calculate diff (file items are like "relay items" in this context)
    const diff = this.calculateDiff(browserItems, fileItems, false);

    // Requires confirmation if browser has items that would be lost
    const requiresConfirmation = diff.removed.length > 0;

    return {
      requiresConfirmation,
      diff,
      fileItems
    };
  }

  /**
   * Button 4: "Restore from local file" - Phase 2
   *
   * Apply file restore after user decision
   * @param strategy 'merge' = keep browser items + add file items
   *                 'overwrite' = replace browser with file
   */
  async applySyncFromFile(strategy: SyncStrategy, fileItems: T[]): Promise<void> {
    const browserItems = this.adapter.getBrowserItems();

    if (strategy === 'overwrite') {
      // Only restore folder structure on overwrite (replaces everything)
      await this.restoreFolderDataFromFile();
      this.adapter.setBrowserItems(fileItems);
    } else {
      // Merge: keep all browser items + add new from file
      const merged = this.mergeItems(browserItems, fileItems);
      this.adapter.setBrowserItems(merged);
    }
  }

  /**
   * Legacy: Simple restore from file (for backward compatibility)
   * Use syncFromFile() + applySyncFromFile() for conflict handling
   */
  async restoreFromFile(): Promise<boolean> {
    if (PlatformService.getInstance().isTauri) {
      const result = await this.syncFromFile();

      // If would lose data, throw error (legacy behavior)
      if (result.requiresConfirmation) {
        throw new Error(`File has fewer items than browser. ${result.diff.removed.length} items would be lost.`);
      }

      await this.applySyncFromFile('overwrite', result.fileItems);
      return true;
    } else {
      // Browser: Prompt file upload and parse JSON
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';

        input.onchange = async (e) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          if (!file) {
            resolve(false);
            return;
          }

          try {
            const text = await file.text();
            const items = JSON.parse(text);

            if (Array.isArray(items)) {
              this.adapter.setBrowserItems(items);
              resolve(true);
            } else {
              console.error('Invalid file format: expected array');
              resolve(false);
            }
          } catch (error) {
            console.error('Failed to parse file:', error);
            resolve(false);
          }
        };

        input.oncancel = () => resolve(false);
        input.click();
      });
    }
  }

  /**
   * Download data as JSON file (Browser fallback)
   */
  private downloadAsJson(data: T[], filename: string): void {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `noornote-${filename.toLowerCase()}-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ===== Helper Methods =====

  /**
   * Calculate diff between browser (local) and relay (remote)
   *
   * @param browserItems Current items in browser storage
   * @param relayItems Items fetched from relays
   * @param relayContentWasEmpty If true, private items are excluded from "removed"
   *        (another client without private support may have overwritten - see spec)
   * @returns added (in relay, not in browser), removed (in browser, not in relay), unchanged (in both)
   */
  private calculateDiff(browserItems: T[], relayItems: T[], relayContentWasEmpty: boolean = false): SyncDiff<T> {
    const browserIds = new Set(browserItems.map(item => this.adapter.getItemId(item)));
    const relayIds = new Set(relayItems.map(item => this.adapter.getItemId(item)));

    // Items in relay but not in browser (new items)
    const added = relayItems.filter(item => !browserIds.has(this.adapter.getItemId(item)));

    // Items in browser but not in relay (deleted on relay)
    // EDGE CASE: If relay content was empty, exclude private items from "removed"
    // (another client without private support may have overwritten - see LIST-MANAGEMENT-SPEC.md)
    const removed = browserItems.filter(item => {
      if (!relayIds.has(this.adapter.getItemId(item))) {
        // Item is not in relay - would normally be "removed"
        // But if relay content was empty and item is private, preserve it
        if (relayContentWasEmpty && (item as any).isPrivate === true) {
          return false; // Don't mark private items as removed
        }
        return true;
      }
      return false;
    });

    // Items in both
    const unchanged = browserItems.filter(item => relayIds.has(this.adapter.getItemId(item)));

    return { added, removed, unchanged };
  }

  /**
   * Merge browser items with relay items (union)
   * Keeps all browser items + adds new items from relay
   *
   * @param browserItems Current browser items
   * @param relayItems Items from relay
   * @returns Merged list (deduplicated)
   */
  private mergeItems(browserItems: T[], relayItems: T[]): T[] {
    const map = new Map<string, T>();

    // Add all browser items
    browserItems.forEach(item => {
      map.set(this.adapter.getItemId(item), item);
    });

    // Add relay items (only new ones, browser items take precedence)
    relayItems.forEach(item => {
      const id = this.adapter.getItemId(item);
      if (!map.has(id)) {
        map.set(id, item);
      }
    });

    return Array.from(map.values());
  }
}
