/**
 * Extract Original Note ID from Event
 * For regular notes: returns their ID
 * For reposts (kind 6): extracts the original note ID from tags or embedded event
 *
 * @param event - Nostr event
 * @returns Original note ID (for stats, ISL, etc.)
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';

export function extractOriginalNoteId(event: NostrEvent): string | undefined {
  // For regular notes (not reposts), return their ID
  if (event.kind !== 6 && event.kind !== 16) {
    return event.id;
  }

  // For reposts (kind 6): extract original note ID

  // Try e-tags first (most common)
  const eTags = event.tags.filter(tag => tag[0] === 'e');
  const firstETagValue = eTags[0]?.[1];
  if (firstETagValue) {
    return firstETagValue;
  }

  // Try parsing embedded event (legacy format)
  try {
    const embedded = JSON.parse(event.content);
    if (embedded && embedded.id) {
      return embedded.id;
    }
  } catch (error) {
    // Not JSON or invalid, ignore
  }

  // Fallback: return repost ID itself (shouldn't happen in practice)
  return event.id;
}
