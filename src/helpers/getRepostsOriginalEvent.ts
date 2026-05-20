/**
 * Get Repost's Original Event
 *
 * Universal helper to handle repost unwrapping across the app.
 * Used by: ISL (repost/quote), NotificationItem, SNV, etc.
 *
 * Rules:
 * - Regular notes (kind !== 6): Return as-is
 * - Reposts (kind 6): Extract original note from content (JSON) or fetch via e-tag
 *
 * Outbound resolution: when fetching by e-tag, the p-tag in a NIP-18 repost
 * identifies the original author. We route the fetch through QuoteOrchestrator
 * with that pubkey so it can fall back to the author's outbound relays if the
 * original isn't on our read relays.
 *
 * @param event - Nostr event (potentially a repost)
 * @returns Original event (unwrapped if repost, same if not)
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';

export async function getRepostsOriginalEvent(event: NostrEvent): Promise<NostrEvent> {
  // Not a repost - return as-is
  if (event.kind !== 6) {
    return event;
  }

  // Repost (kind 6) - extract original note

  // Try 1: Parse from content (legacy format - embedded JSON)
  if (event.content) {
    try {
      const embeddedEvent = JSON.parse(event.content);
      if (embeddedEvent && embeddedEvent.id && embeddedEvent.kind) {
        return embeddedEvent;
      }
    } catch {
      // Not JSON or invalid - continue to e-tag method
    }
  }

  // Try 2: Fetch via e-tag (modern format - NIP-18)
  const eTag = event.tags.find(t => t[0] === 'e');
  if (eTag && eTag[1]) {
    try {
      const { QuoteOrchestrator } = await import('../services/orchestration/QuoteOrchestrator');
      // NIP-18: p-tag carries the original author pubkey
      const pTag = event.tags.find(t => t[0] === 'p');
      const originalAuthor = pTag?.[1];

      const originalEvent = await QuoteOrchestrator.getInstance().fetchQuotedEvent(eTag[1], originalAuthor);
      if (originalEvent) {
        return originalEvent;
      }
    } catch (error) {
      console.warn('[getRepostsOriginalEvent] Failed to fetch original note via e-tag:', error);
    }
  }

  // Fallback: Return repost itself (shouldn't happen in practice)
  console.warn('[getRepostsOriginalEvent] Could not extract original event, returning repost itself');
  return event;
}
