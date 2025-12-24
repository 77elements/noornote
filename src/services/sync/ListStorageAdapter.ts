/**
 * @interface ListStorageAdapter
 * @purpose Generic adapter for list storage operations across Browser/File/Relays
 * @used-by ListSyncManager
 */

export interface SyncDiff<T> {
  added: T[];
  removed: T[];
  unchanged: T[];
}

/**
 * Result from fetchFromRelays including metadata about the relay event
 * Used to detect if another client (without private support) overwrote the event
 */
export interface FetchFromRelaysResult<T> {
  items: T[];
  /**
   * True if relay event's content field was empty/whitespace
   * Indicates another client without private item support may have overwritten
   * In this case, local private items should be preserved during sync
   */
  relayContentWasEmpty: boolean;
  /**
   * True if private items could not be decrypted (e.g., hardware signer limitation)
   * In this case, local private items should be preserved during sync
   */
  decryptionFailed?: boolean;
  /**
   * Category assignments from relay (bookmarkId -> categoryName)
   * Only used for Bookmarks (NIP-51 kind:30003 with d-tag)
   */
  categoryAssignments?: Map<string, string>;
  /**
   * Category names (d-tags) found on relays
   * Only used for Bookmarks
   */
  categories?: string[];
}

export interface ListStorageAdapter<T> {
  /**
   * Get unique identifier for an item (used for comparison)
   */
  getItemId(item: T): string;

  /**
   * Browser Storage Operations (Runtime)
   */
  getBrowserItems(): T[];
  setBrowserItems(items: T[]): void;

  /**
   * File Storage Operations (Persistent Local: ~/.noornote/*.json)
   */
  getFileItems(): Promise<T[]>;
  setFileItems(items: T[]): Promise<void>;

  /**
   * Restore folder data from file to per-account storage (optional)
   * Only applicable to lists that use folder organization (Bookmarks, Tribes)
   */
  restoreFolderDataFromFile?(): Promise<void>;

  /**
   * Relay Storage Operations (Remote: User's Write-Relays)
   *
   * fetchFromRelays returns items AND metadata about whether content was empty
   * (to handle mixed-client private item edge case - see LIST-MANAGEMENT-SPEC.md)
   */
  fetchFromRelays(): Promise<FetchFromRelaysResult<T>>;
  publishToRelays(items: T[]): Promise<void>;
}
