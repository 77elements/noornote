/**
 * Shared "quoted reposts + threaded replies" plumbing for the SNV reply
 * renderers (RepliesRenderer + ThreadManager). Both fetch/merge/render the
 * same way — this module holds that logic ONCE so the two views cannot
 * drift apart (jscpd H5 clone-budget consolidation, 2026-09-29).
 */

import { fetchNostrEvents } from '../services/FetchNostrEvents';
import { type ThreadNode } from './threadTree';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

/**
 * Fetch quoted reposts (kind 1 or 6 referencing this note via NIP-18 'q',
 * addressable '#a', or legacy e-tag-mention + nostr: URI in content).
 * Candidates are deduped by event id.
 */
export async function fetchQuotedRepostCandidates(
  relays: string[],
  noteId: string
): Promise<NostrEvent[]> {
  // Addressable events (NIP-33 kinds 30000–39999) are referenced via #a,
  // not #e — passing a coordinate through the #e filter is rejected by NDK
  // as "not a valid 64-char hex string".
  const isAddressable = noteId.includes(':');

  // Two relay queries in parallel: NIP-18 q-tag AND legacy e-tag-with-mention
  // (Primal-iOS pre-NIP-18 pattern). Tag-OR can't be expressed in one filter.
  const fetches: Array<Promise<{ events: NostrEvent[] }>> = [
    fetchNostrEvents({
      relays,
      kinds: [1, 6],
      tags: { q: [noteId] },
      limit: 100,
    }),
  ];
  if (isAddressable) {
    fetches.push(
      fetchNostrEvents({
        relays,
        kinds: [1, 6],
        tags: { a: [noteId] },
        limit: 100,
      })
    );
  } else {
    fetches.push(
      fetchNostrEvents({
        relays,
        kinds: [1],
        tags: { e: [noteId] },
        limit: 100,
      })
    );
  }
  const results = await Promise.all(fetches);
  const qTagResult = results[0]!;
  const eTagResult = results[1]!;

  const byId = new Map<string, NostrEvent>();
  for (const ev of [...qTagResult.events, ...eTagResult.events]) {
    if (ev.id) byId.set(ev.id, ev);
  }

  return Array.from(byId.values()).filter(event => {
    const hasContent = event.content.trim().length > 0;
    if (!hasContent) return false;

    if (event.tags.some(tag => tag[0] === 'q' && tag[1] === noteId))
      return true;

    if (isAddressable) {
      // Addressable: match via #a tag
      return event.tags.some(tag => tag[0] === 'a' && tag[1] === noteId);
    }

    const eTags = event.tags.filter(tag => tag[0] === 'e' && tag[1] === noteId);
    return (
      eTags.some(tag => tag[3] === 'mention') &&
      /nostr:(nevent1|note1|naddr1)/.test(event.content)
    );
  });
}

/** A timeline entry in a thread view: a threaded reply or a quoted repost. */
export type ThreadComment =
  | { type: 'reply'; node: ThreadNode; timestamp: number }
  | { type: 'quote'; event: NostrEvent; timestamp: number };

/**
 * Merge threaded replies + quoted reposts into one chronological list
 * (oldest first).
 */
export function mergeChronologicalComments(
  threadTree: ThreadNode[],
  quotedReposts: NostrEvent[]
): ThreadComment[] {
  return [
    ...threadTree.map(node => ({
      type: 'reply' as const,
      node,
      timestamp: node.event.created_at,
    })),
    ...quotedReposts.map(event => ({
      type: 'quote' as const,
      event,
      timestamp: event.created_at,
    })),
  ].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Render a thread node recursively (depth-first, pre-order) into the
 * container. `createReplyElement` builds the DOM element for one event at
 * the given depth.
 */
export function renderThreadedReplyNodes(
  node: ThreadNode,
  container: Element,
  createReplyElement: (event: NostrEvent, depth: number) => HTMLElement
): void {
  container.appendChild(createReplyElement(node.event, node.depth));

  // Recursively render children
  node.children.forEach(childNode => {
    renderThreadedReplyNodes(childNode, container, createReplyElement);
  });
}
