/**
 * Direct-reply classification for notifications.
 *
 * Used to be decided purely by "is the parent event ID in USER_EVENT_IDS" — that
 * list only holds the last 50 own events fetched once at login, so every reply
 * to an older note (or one posted after that fetch) fell through to
 * 'thread-reply' and lit the low-priority diode. These helpers add the
 * tag-convention heuristics that work without any fetch window:
 *
 * - NIP-10 (kind 1/20): the direct parent's author sits at the SAME index in the
 *   p-tag list as the parent e-tag has in the e-tag list (thread order root→parent);
 *   mentions typed into the reply are appended after, so index mapping survives them.
 * - NIP-22 (kind 1111): the first lowercase 'p' tag is the direct parent's author —
 *   this also covers addressable parents (e.g. article comments), which carry no 'e'.
 *
 * The parent-ID membership checks and the NoteService cache lookup remain as the
 * precise paths; the p-tag heuristics are the fallback for uncached parents.
 */

export interface DirectReplyContext {
  tags: string[][];
  userPubkey: string;
  /** Event IDs known to belong to the user (fetch window — incomplete by design). */
  userEventIds: string[];
  /** Optional cache lookup for the parent event's author (e.g. NoteService). */
  resolveParentAuthor?: (eventId: string) => string | null;
}

/**
 * NIP-10 (kind 1/20): is this note a direct reply to the user's own note?
 * Thread replies (parent authored by someone else, user's note as root only)
 * must return false.
 */
export function isDirectReplyToOwnNote(ctx: DirectReplyContext): boolean {
  const { tags, userPubkey, userEventIds, resolveParentAuthor } = ctx;
  const eTags = tags.filter(t => t[0] === 'e');
  if (eTags.length === 0) return false;

  // Resolve the direct parent e-tag. Priority: 'reply' marker; 'root' marker
  // only when it is the sole e-tag (a direct reply to the root has no 'reply'
  // marker); otherwise deprecated positional NIP-10 — last e-tag is the parent.
  const markedReplyTag = eTags.find(t => t[3] === 'reply');
  const markedRootTag = eTags.find(t => t[3] === 'root');
  const directTargetTag =
    markedReplyTag ??
    (markedRootTag && eTags.length === 1 ? markedRootTag : undefined) ??
    eTags[eTags.length - 1];
  const directTargetId = directTargetTag?.[1];
  if (!directTargetId) return false;

  // 1. Fetch-window membership (precise when the parent is in the window).
  if (userEventIds.includes(directTargetId)) return true;

  // 2. Cache lookup (precise, no window limit).
  const cachedAuthor = resolveParentAuthor?.(directTargetId);
  if (cachedAuthor) return cachedAuthor === userPubkey;

  // 3. Parallel-index p-tag heuristic: parent author sits at the parent
  //    e-tag's index in the p-tag list. When the parent IS the root, clients
  //    dedupe the p-tags (root author = parent author), so p[0] is a second
  //    valid candidate for that case.
  const parentIndex = directTargetTag ? eTags.indexOf(directTargetTag) : -1;
  const pTags = tags.filter(t => t[0] === 'p');
  const rootId = markedRootTag?.[1];
  const candidates = [pTags[parentIndex]?.[1]];
  if (directTargetId && directTargetId === rootId) {
    candidates.push(pTags[0]?.[1]);
  }
  return candidates.includes(userPubkey);
}

/**
 * NIP-22 (kind 1111): is this comment a direct reply to the user's own content?
 */
export function isDirectCommentToOwnContent(ctx: DirectReplyContext): boolean {
  const { tags, userPubkey, userEventIds } = ctx;
  const parentTargetId = tags.find(t => t[0] === 'e')?.[1];
  const rootTargetId = tags.find(t => t[0] === 'E')?.[1];

  // 1. Fetch-window membership (precise when the parent/root is in the window).
  if (parentTargetId && userEventIds.includes(parentTargetId)) return true;
  if (rootTargetId && userEventIds.includes(rootTargetId) && !parentTargetId)
    return true;

  // 2. NIP-22: first lowercase 'p' = direct parent author. Covers uncached
  //    parents and addressable parents (article comments carry no 'e' tag).
  //    Extra mention p-tags are appended after, so FIRST is the structural one.
  const parentAuthor = tags.find(t => t[0] === 'p')?.[1];
  return parentAuthor === userPubkey;
}
