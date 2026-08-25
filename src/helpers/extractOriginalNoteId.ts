/**
 * Extract Original Note ID from Event
 * For regular notes: returns their ID
 * For addressable / replaceable events (NIP-33, kinds 30000–39999): returns
 *   the coordinate (`kind:pubkey:d-tag`). Stats, reactions, zaps and replies
 *   on addressable events use `#a` tags, so the ISL / Reaction / Zap / Reply
 *   pipelines need the coordinate, not the hex event id (which disappears
 *   from relays after the author publishes a newer version).
 * For reposts (kind 6 / 16): extracts the original note ID from tags or
 *   embedded event, recursively unwrapping when the inner event is itself
 *   addressable.
 *
 * @param event - Nostr event
 * @returns Original note ID (for stats, ISL, etc.)
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';

const ADDRESSABLE_KIND_MIN = 30000;
const ADDRESSABLE_KIND_MAX = 39999;

function isAddressableKind(kind: number | undefined): boolean {
  return (
    typeof kind === 'number' &&
    kind >= ADDRESSABLE_KIND_MIN &&
    kind <= ADDRESSABLE_KIND_MAX
  );
}

function addressableCoordinate(event: NostrEvent): string | undefined {
  if (!isAddressableKind(event.kind)) return undefined;
  const dTag = event.tags.find(t => t[0] === 'd')?.[1];
  if (!dTag) return undefined;
  return `${event.kind}:${event.pubkey}:${dTag}`;
}

export function extractOriginalNoteId(event: NostrEvent): string | undefined {
  // For reposts (kind 6 / 16): extract the inner event id, recursing into
  // embedded JSON if present so an addressable inner event surfaces its
  // coordinate instead of a hex id that may already be gone from relays.
  if (event.kind === 6 || event.kind === 16) {
    // Try e-tags first (most common)
    const eTags = event.tags.filter(tag => tag[0] === 'e');
    const firstETagValue = eTags[0]?.[1];
    if (firstETagValue) {
      return firstETagValue;
    }

    // Try parsing embedded event (legacy format)
    try {
      // kind:6 legacy repost embeds the original event (relay-controlled)
      const embedded = JSON.parse(event.content) as {
        id?: string;
        kind?: number;
        pubkey?: string;
        tags?: string[][];
      };
      if (embedded && embedded.id) {
        // Recurse: if the embedded event is itself addressable, hand back
        // its coordinate; otherwise its hex id.
        if (isAddressableKind(embedded.kind)) {
          const coord = addressableCoordinate(embedded as NostrEvent);
          if (coord) return coord;
        }
        return embedded.id;
      }
    } catch {
      // Not JSON or invalid, ignore
    }

    // Fallback: return repost ID itself (shouldn't happen in practice)
    return event.id;
  }

  // For addressable top-level events: return the coordinate.
  const coord = addressableCoordinate(event);
  if (coord) return coord;

  // For regular notes: return their hex id.
  return event.id;
}
