/**
 * bookmarkReadMerge — pure merge logic for the bookmark read-state sync.
 *
 * Read-markers map bookmark ids to the time they were marked read. The map
 * is synced across instances via NIP-78 (kind:30078, d-tag
 * "noornote-bookmarks-read", NIP-44 self-encrypted — see
 * docs/todos/unread-bookmarks.md).
 *
 * Merge semantics: union of both maps, newest readAt wins per id ("read is
 * read" — monotonic, no unread-resurrection), pruned to bookmark ids that
 * still exist locally (markers for deleted bookmarks are meaningless and
 * would grow the map unboundedly).
 *
 * Dependency-free so tests can import it standalone — the PerAccountStorage
 * import chain self-circles through lists (see the PackFormat lesson).
 */

export type BookmarkReadMap = Record<string, number>;

export function mergeBookmarkReadMaps(
  local: BookmarkReadMap,
  remote: BookmarkReadMap,
  existingIds: Set<string>
): BookmarkReadMap {
  const merged: BookmarkReadMap = {};
  const ids = new Set([...Object.keys(local), ...Object.keys(remote)]);
  for (const id of ids) {
    if (!existingIds.has(id)) continue;
    const localAt = local[id];
    const remoteAt = remote[id];
    merged[id] = Math.max(localAt ?? 0, remoteAt ?? 0);
  }
  return merged;
}

/** Drop markers for bookmark ids that no longer exist in the local list. */
export function pruneReadMap(
  map: BookmarkReadMap,
  existingIds: Set<string>
): BookmarkReadMap {
  const pruned: BookmarkReadMap = {};
  for (const [id, at] of Object.entries(map)) {
    if (existingIds.has(id)) pruned[id] = at;
  }
  return pruned;
}
