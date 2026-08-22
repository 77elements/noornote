/**
 * BaseListItem - Unified interface for all list types
 * Used by GenericListOrchestrator for type-safe list management
 */

export interface BaseListItem {
  id: string; // Unique identifier (pubkey, eventId, etc.)
  isPrivate?: boolean; // Private status (for "Save to File" categorization)
  addedAt?: number; // Timestamp when added
}

/**
 * MuteItem - Unified mute list item (users + threads)
 * Replaces old string[] approach with structured data
 */
export interface MuteItem extends BaseListItem {
  id: string; // pubkey OR eventId
  type: 'user' | 'thread';
  isPrivate?: boolean;
  addedAt?: number;
}

/**
 * Migration Helper: Convert old 4-key storage to new unified format
 *
 * Old format:
 * - noornote_mutes_browser (public users: string[])
 * - noornote_mutes_private_browser (private users: string[])
 * - noornote_muted_threads_browser (public threads: string[])
 * - noornote_muted_threads_private_browser (private threads: string[])
 *
 * New format:
 * - noornote_mutes_browser (unified: MuteItem[])
 */
export function migrateMuteStorage(): MuteItem[] {
  const migratedItems: MuteItem[] = [];
  const now = Math.floor(Date.now() / 1000);

  try {
    // Read old format
    const publicUsers = JSON.parse(
      localStorage.getItem('noornote_mutes_browser') || '[]'
    ) as string[];
    const privateUsers = JSON.parse(
      localStorage.getItem('noornote_mutes_private_browser') || '[]'
    ) as string[];
    const publicThreads = JSON.parse(
      localStorage.getItem('noornote_muted_threads_browser') || '[]'
    ) as string[];
    const privateThreads = JSON.parse(
      localStorage.getItem('noornote_muted_threads_private_browser') || '[]'
    ) as string[];

    // Convert to new format
    publicUsers.forEach(id => {
      migratedItems.push({
        id,
        type: 'user',
        isPrivate: false,
        addedAt: now,
      });
    });

    privateUsers.forEach(id => {
      migratedItems.push({
        id,
        type: 'user',
        isPrivate: true,
        addedAt: now,
      });
    });

    publicThreads.forEach(id => {
      migratedItems.push({
        id,
        type: 'thread',
        isPrivate: false,
        addedAt: now,
      });
    });

    privateThreads.forEach(id => {
      migratedItems.push({
        id,
        type: 'thread',
        isPrivate: true,
        addedAt: now,
      });
    });

    console.log(
      `[MuteStorage] Migrated ${migratedItems.length} items from old format`
    );
    return migratedItems;
  } catch (error) {
    console.error('[MuteStorage] Migration failed:', error);
    return [];
  }
}

/**
 * Check if migration is needed (old keys exist, new key doesn't)
 */
export function needsMuteMigration(): boolean {
  const hasOldKeys =
    localStorage.getItem('noornote_mutes_browser') !== null ||
    localStorage.getItem('noornote_mutes_private_browser') !== null ||
    localStorage.getItem('noornote_muted_threads_browser') !== null ||
    localStorage.getItem('noornote_muted_threads_private_browser') !== null;

  const hasNewKey = localStorage.getItem('noornote_mutes_browser_v2') !== null;

  return hasOldKeys && !hasNewKey;
}

/**
 * Cleanup old storage keys after successful migration
 */
export function cleanupOldMuteStorage(): void {
  localStorage.removeItem('noornote_mutes_browser');
  localStorage.removeItem('noornote_mutes_private_browser');
  localStorage.removeItem('noornote_muted_threads_browser');
  localStorage.removeItem('noornote_muted_threads_private_browser');
  console.log('[MuteStorage] Cleaned up old storage keys');
}
