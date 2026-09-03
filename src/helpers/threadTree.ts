/**
 * Thread-tree building shared by RepliesRenderer and ThreadManager.
 *
 * Both previously carried byte-identical copies of the node type, the tree
 * builder and (drifting!) parent extraction — ThreadManager lacked the
 * NIP-22 branch, so kind:1111 comments mis-nested there. Single source here.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';

export interface ThreadNode {
  event: NostrEvent;
  children: ThreadNode[];
  depth: number;
}

/**
 * Extract the parent ID from a reply's tags (NIP-10 for kind:1, NIP-22 for
 * kind:1111).
 */
export function extractReplyParentId(reply: NostrEvent): string | null {
  // NIP-22: kind:1111 uses lowercase 'e' tag for parent reference
  if (reply.kind === 1111) {
    const parentETag = reply.tags.find(t => t[0] === 'e');
    return parentETag?.[1] ?? null;
  }

  // NIP-10: kind:1 uses e-tags with markers
  const eTags = reply.tags.filter(tag => tag[0] === 'e');
  if (eTags.length === 0) return null;

  // NIP-10: Look for explicit "reply" marker
  const replyTag = eTags.find(tag => tag[3] === 'reply');
  if (replyTag?.[1]) return replyTag[1];

  // NIP-10 deprecated: last e-tag is the replied-to note
  const lastTag = eTags[eTags.length - 1];
  return lastTag?.[1] ?? null;
}

/**
 * Build the nested reply tree: events whose parent is the root note (or has
 * no parent in the set) become roots; everything else nests under its parent.
 */
export function buildThreadTree(
  replies: NostrEvent[],
  rootNoteId: string
): ThreadNode[] {
  const nodes = new Map<string, ThreadNode>();
  const rootNodes: ThreadNode[] = [];

  // Create nodes for all replies
  replies.forEach(reply => {
    const replyId = reply.id;
    if (!replyId) return;
    nodes.set(replyId, { event: reply, children: [], depth: 0 });
  });

  // Build parent-child relationships
  replies.forEach(reply => {
    const replyId = reply.id;
    if (!replyId) return;
    const node = nodes.get(replyId)!;
    const parentId = extractReplyParentId(reply);

    if (!parentId || parentId === rootNoteId) {
      // Top-level reply (directly replying to the main note)
      rootNodes.push(node);
    } else {
      // Child reply (replying to another reply)
      const parentNode = nodes.get(parentId);
      if (parentNode) {
        node.depth = parentNode.depth + 1;
        parentNode.children.push(node);
      } else {
        // Parent not found in replies, treat as root-level
        rootNodes.push(node);
      }
    }
  });

  return rootNodes;
}
