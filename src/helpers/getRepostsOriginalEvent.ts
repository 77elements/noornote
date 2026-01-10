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
      const { NostrTransport } = await import('../services/transport/NostrTransport');
      const { RelayConfig } = await import('../services/RelayConfig');

      const transport = NostrTransport.getInstance();
      const relays = RelayConfig.getInstance().getReadRelays();

      const events = await transport.fetch(relays, [{ ids: [eTag[1]] }]);
      const originalEvent = events[0];
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
