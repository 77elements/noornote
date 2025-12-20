/**
 * BookmarkSerializer - Central serialization for NIP-51 Bookmark Sets
 *
 * Converts between:
 * - BookmarkSetData (internal format)
 * - Nostr Events (kind:30003)
 * - Old file format (for migration)
 */

import type { BookmarkSetData, BookmarkSet, BookmarkTag } from '../../../types/BookmarkSetData';
import type { BookmarkItem, BookmarkFolder } from '../../storage/BookmarkFileStorage';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

/**
 * Old file format (for migration)
 */
interface OldBookmarkFileData {
  items: BookmarkItem[];
  folders?: BookmarkFolder[];
  folderAssignments?: { bookmarkId: string; folderId: string; order: number }[];
  rootOrder?: { type: 'folder' | 'bookmark'; id: string }[];
  lastModified: number;
}

/**
 * Create empty BookmarkSetData
 */
export function createEmptyBookmarkSetData(): BookmarkSetData {
  return {
    version: 2,
    sets: [{
      kind: 30003,
      d: '',
      title: '',  // d-tag = title-tag
      publicTags: [],
      privateTags: []
    }],
    metadata: {
      setOrder: [''],
      lastModified: Math.floor(Date.now() / 1000)
    }
  };
}

/**
 * Migrate from old file format to BookmarkSetData
 */
export function migrateFromOldFormat(oldData: OldBookmarkFileData): BookmarkSetData {
  const folders = oldData.folders || [];
  const assignments = oldData.folderAssignments || [];
  const rootOrder = oldData.rootOrder || [];

  // Build sets from folders
  const sets: BookmarkSet[] = [];

  // Create root set
  const rootSet: BookmarkSet = {
    kind: 30003,
    d: '',
    title: '',  // d-tag = title-tag
    publicTags: [],
    privateTags: []
  };

  // Create a set for each folder
  const folderSets = new Map<string, BookmarkSet>();
  for (const folder of folders) {
    const set: BookmarkSet = {
      kind: 30003,
      d: folder.name,
      title: folder.name,
      publicTags: [],
      privateTags: []
    };
    folderSets.set(folder.id, set);
  }

  // Build item map for quick lookup
  const itemMap = new Map<string, BookmarkItem>();
  for (const item of oldData.items) {
    itemMap.set(item.id, item);
  }

  // Group assignments by folder and sort by order
  const rootAssignments: typeof assignments = [];
  const folderAssignmentsMap = new Map<string, typeof assignments>();

  for (const assignment of assignments) {
    if (assignment.folderId && folderSets.has(assignment.folderId)) {
      const existing = folderAssignmentsMap.get(assignment.folderId) || [];
      existing.push(assignment);
      folderAssignmentsMap.set(assignment.folderId, existing);
    } else {
      rootAssignments.push(assignment);
    }
  }

  // Find items without assignments (add to root)
  const assignedIds = new Set(assignments.map(a => a.bookmarkId));
  for (const item of oldData.items) {
    if (!assignedIds.has(item.id)) {
      rootAssignments.push({ bookmarkId: item.id, folderId: '', order: rootAssignments.length });
    }
  }

  // Sort and add root items
  rootAssignments.sort((a, b) => a.order - b.order);
  for (const assignment of rootAssignments) {
    const item = itemMap.get(assignment.bookmarkId);
    if (item) {
      const tag: BookmarkTag = { type: item.type, value: item.value, description: item.description };
      if (item.isPrivate) {
        rootSet.privateTags.push(tag);
      } else {
        rootSet.publicTags.push(tag);
      }
    }
  }

  // Sort and add folder items
  for (const [folderId, folderAssignments] of folderAssignmentsMap) {
    const set = folderSets.get(folderId)!;
    folderAssignments.sort((a, b) => a.order - b.order);

    for (const assignment of folderAssignments) {
      const item = itemMap.get(assignment.bookmarkId);
      if (item) {
        const tag: BookmarkTag = { type: item.type, value: item.value, description: item.description };
        if (item.isPrivate) {
          set.privateTags.push(tag);
        } else {
          set.publicTags.push(tag);
        }
      }
    }
  }

  // Build sets array with root first
  sets.push(rootSet);
  for (const set of folderSets.values()) {
    sets.push(set);
  }

  // Build setOrder from rootOrder (folders only, by name)
  const setOrder: string[] = [''];
  for (const item of rootOrder) {
    if (item.type === 'folder') {
      const folder = folders.find(f => f.id === item.id);
      if (folder) {
        setOrder.push(folder.name);
      }
    }
  }

  // Add any folders not in rootOrder
  for (const folder of folders) {
    if (!setOrder.includes(folder.name)) {
      setOrder.push(folder.name);
    }
  }

  return {
    version: 2,
    sets,
    metadata: {
      setOrder,
      lastModified: oldData.lastModified
    }
  };
}

/**
 * Convert BookmarkSetData to Nostr events (one per set)
 */
export function toNostrEvents(
  data: BookmarkSetData,
  pubkey: string,
  encryptPrivateTags: (tags: BookmarkTag[], pubkey: string) => Promise<string>
): Promise<Array<{ tags: string[][]; content: string }>> {
  return Promise.all(data.sets.map(async (set) => {
    const tags: string[][] = [
      ['d', set.d],
      ['title', set.d]  // d-tag = title-tag
    ];

    // Add public tags
    for (const tag of set.publicTags) {
      if (tag.description) {
        tags.push([tag.type, tag.value, tag.description]);
      } else {
        tags.push([tag.type, tag.value]);
      }
    }

    // Encrypt private tags
    let content = '';
    if (set.privateTags.length > 0) {
      content = await encryptPrivateTags(set.privateTags, pubkey);
    }

    return { tags, content };
  }));
}

/**
 * Convert Nostr events to BookmarkSetData
 */
export function fromNostrEvents(
  events: NostrEvent[],
  decryptContent: (content: string, pubkey: string) => Promise<BookmarkTag[]>
): Promise<BookmarkSetData> {
  return (async () => {
    // Deduplicate by d-tag (keep newest)
    const eventsByDTag = new Map<string, NostrEvent>();
    for (const event of events) {
      const dTag = event.tags.find(t => t[0] === 'd')?.[1] || '';
      const existing = eventsByDTag.get(dTag);
      if (!existing || event.created_at > existing.created_at) {
        eventsByDTag.set(dTag, event);
      }
    }

    const sets: BookmarkSet[] = [];
    const setOrder: string[] = [];

    for (const [dTag, event] of eventsByDTag) {
      setOrder.push(dTag);

      const titleTag = event.tags.find(t => t[0] === 'title')?.[1] || dTag;  // d-tag = title-tag

      // Extract public tags
      const publicTags: BookmarkTag[] = [];
      for (const tag of event.tags) {
        if (['e', 'a', 't', 'r'].includes(tag[0]) && tag[1]) {
          const bookmarkTag: BookmarkTag = { type: tag[0] as 'e' | 'a' | 't' | 'r', value: tag[1] };
          // r-tags can have description as third element
          if (tag[2]) {
            bookmarkTag.description = tag[2];
          }
          publicTags.push(bookmarkTag);
        }
      }

      // Decrypt private tags
      let privateTags: BookmarkTag[] = [];
      if (event.content && event.content.trim()) {
        try {
          privateTags = await decryptContent(event.content, event.pubkey);
        } catch (e) {
          console.error(`[BookmarkSerializer] Failed to decrypt content for d="${dTag}":`, e);
        }
      }

      sets.push({
        kind: 30003,
        d: dTag,
        title: titleTag,
        publicTags,
        privateTags
      });
    }

    // Ensure root set exists
    if (!setOrder.includes('')) {
      setOrder.unshift('');
      sets.unshift({
        kind: 30003,
        d: '',
        title: '',  // d-tag = title-tag
        publicTags: [],
        privateTags: []
      });
    }

    return {
      version: 2,
      sets,
      metadata: {
        setOrder,
        lastModified: Math.floor(Date.now() / 1000)
      }
    };
  })();
}

/**
 * Check if data is old format
 */
export function isOldFormat(data: unknown): data is OldBookmarkFileData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return Array.isArray(obj.items) && obj.version !== 2;
}

/**
 * Check if data is new format
 */
export function isNewFormat(data: unknown): data is BookmarkSetData {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  return obj.version === 2 && Array.isArray(obj.sets);
}

/**
 * Get all bookmark values from BookmarkSetData (for fetching events)
 */
export function getAllBookmarkValues(data: BookmarkSetData): string[] {
  const values: string[] = [];
  for (const set of data.sets) {
    for (const tag of [...set.publicTags, ...set.privateTags]) {
      if (!values.includes(tag.value)) {
        values.push(tag.value);
      }
    }
  }
  return values;
}

/**
 * Check if a bookmark exists
 */
export function isBookmarked(data: BookmarkSetData, value: string): { exists: boolean; isPrivate: boolean; dTag: string } {
  for (const set of data.sets) {
    if (set.publicTags.some(t => t.value === value)) {
      return { exists: true, isPrivate: false, dTag: set.d };
    }
    if (set.privateTags.some(t => t.value === value)) {
      return { exists: true, isPrivate: true, dTag: set.d };
    }
  }
  return { exists: false, isPrivate: false, dTag: '' };
}

/**
 * Add a bookmark to a set
 */
export function addBookmark(
  data: BookmarkSetData,
  dTag: string,
  tag: BookmarkTag,
  isPrivate: boolean
): void {
  let set = data.sets.find(s => s.d === dTag);
  if (!set) {
    set = {
      kind: 30003,
      d: dTag,
      title: dTag,  // d-tag = title-tag
      publicTags: [],
      privateTags: []
    };
    data.sets.push(set);
    data.metadata.setOrder.push(dTag);
  }

  const targetArray = isPrivate ? set.privateTags : set.publicTags;
  if (!targetArray.some(t => t.type === tag.type && t.value === tag.value)) {
    targetArray.push(tag);
    data.metadata.lastModified = Math.floor(Date.now() / 1000);
  }
}

/**
 * Remove a bookmark from all sets
 */
export function removeBookmark(data: BookmarkSetData, value: string): void {
  for (const set of data.sets) {
    set.publicTags = set.publicTags.filter(t => t.value !== value);
    set.privateTags = set.privateTags.filter(t => t.value !== value);
  }
  data.metadata.lastModified = Math.floor(Date.now() / 1000);
}

/**
 * Move a bookmark to a different set
 */
export function moveBookmark(data: BookmarkSetData, value: string, targetDTag: string): void {
  let foundTag: BookmarkTag | null = null;
  let wasPrivate = false;

  // Find and remove
  for (const set of data.sets) {
    const pubIdx = set.publicTags.findIndex(t => t.value === value);
    if (pubIdx !== -1) {
      foundTag = set.publicTags[pubIdx];
      set.publicTags.splice(pubIdx, 1);
      break;
    }
    const privIdx = set.privateTags.findIndex(t => t.value === value);
    if (privIdx !== -1) {
      foundTag = set.privateTags[privIdx];
      wasPrivate = true;
      set.privateTags.splice(privIdx, 1);
      break;
    }
  }

  // Add to target
  if (foundTag) {
    addBookmark(data, targetDTag, foundTag, wasPrivate);
  }
}

/**
 * Create a new set (folder)
 */
export function createSet(data: BookmarkSetData, name: string): void {
  if (data.sets.some(s => s.d === name)) return;

  data.sets.push({
    kind: 30003,
    d: name,
    title: name,
    publicTags: [],
    privateTags: []
  });
  data.metadata.setOrder.push(name);
  data.metadata.lastModified = Math.floor(Date.now() / 1000);
}

/**
 * Delete a set (moves bookmarks to root)
 */
export function deleteSet(data: BookmarkSetData, dTag: string): void {
  if (dTag === '') return; // Can't delete root

  const set = data.sets.find(s => s.d === dTag);
  if (!set) return;

  // Move bookmarks to root
  const rootSet = data.sets.find(s => s.d === '') || data.sets[0];
  rootSet.publicTags.push(...set.publicTags);
  rootSet.privateTags.push(...set.privateTags);

  // Remove the set
  data.sets = data.sets.filter(s => s.d !== dTag);
  data.metadata.setOrder = data.metadata.setOrder.filter(d => d !== dTag);
  data.metadata.lastModified = Math.floor(Date.now() / 1000);
}
