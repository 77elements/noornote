/**
 * Addressable-event dedupe + NIP-09 tombstone filtering, shared by the
 * profile showcase carousels (articles + listings).
 *
 * Semantics (canonical NIP-09):
 * - Dedupe by addressable coordinate `<kind>:<pubkey>:<d>` — NDK's own
 *   Set-dedup runs on event id, so two versions of the same addressable
 *   slot from different relays both reach the caller. Latest created_at
 *   per coordinate survives.
 * - Drop coordinates whose newest kind:5 deletion is newer than the
 *   surviving event (re-creations strictly newer than the deletion stay
 *   visible).
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';

export function dedupeByCoordinateWithTombstones(
  events: NostrEvent[],
  deletionEvents: NostrEvent[],
  coordPrefixes: string[]
): NostrEvent[] {
  // Index NIP-09 `a`-tag deletions targeting our addressable kinds.
  // Map value = most recent deletion's created_at.
  const deletedCoordinates = new Map<string, number>();
  for (const delEvent of deletionEvents) {
    for (const tag of delEvent.tags) {
      if (tag[0] !== 'a' || !tag[1]) continue;
      if (!coordPrefixes.some(p => tag[1]!.startsWith(p))) continue;
      const coord = tag[1];
      const existing = deletedCoordinates.get(coord);
      if (!existing || delEvent.created_at > existing) {
        deletedCoordinates.set(coord, delEvent.created_at);
      }
    }
  }

  const eventsByCoord = new Map<string, NostrEvent>();
  for (const event of events) {
    const dTag = event.tags.find(t => t[0] === 'd')?.[1] ?? '';
    const coord = `${event.kind}:${event.pubkey}:${dTag}`;
    const existing = eventsByCoord.get(coord);
    if (!existing || event.created_at > existing.created_at) {
      eventsByCoord.set(coord, event);
    }
  }

  return Array.from(eventsByCoord.entries())
    .filter(([coord, event]) => {
      const delTs = deletedCoordinates.get(coord);
      return delTs === undefined || event.created_at > delTs;
    })
    .map(([, event]) => event);
}
