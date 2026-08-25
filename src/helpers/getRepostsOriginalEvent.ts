/**
 * Get Repost's Original Event
 *
 * Universal helper to handle repost unwrapping across the app.
 * Used by: ISL (repost/quote), NotificationItem, SNV, etc.
 *
 * Rules:
 * - Regular notes (kind !== 6): Return as-is
 * - Reposts (kind 6 / 16):
 *   1. Try embedded JSON in content
 *   2. Try e-tag fetch via QuoteOrchestrator (relay-hint + read set + outbound
 *      of original author and reposter)
 *   3. For addressable inner kinds (30000–39999), try a-tag fetch via the
 *      Articles module — many relays only carry the *current* version of a
 *      replaceable event under its coordinate, not the original id.
 *
 * @param event - Nostr event (potentially a repost)
 * @returns Original event (unwrapped if repost, same if not)
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';

export async function getRepostsOriginalEvent(
  event: NostrEvent
): Promise<NostrEvent> {
  // Not a repost - return as-is
  if (event.kind !== 6 && event.kind !== 16) {
    return event;
  }

  // Repost (kind 6/16) - extract original note

  // Try 1: Parse from content (legacy format - embedded JSON)
  if (event.content) {
    try {
      // kind:6/16 repost embeds the original event (relay-controlled)
      const embeddedEvent = JSON.parse(event.content) as NostrEvent | null;
      if (embeddedEvent && embeddedEvent.id && embeddedEvent.kind) {
        return embeddedEvent;
      }
    } catch {
      // Not JSON or invalid - continue to e-tag method
    }
  }

  // Determine the inner kind from the optional `k` tag (NIP-18) so we know
  // whether an addressable a-tag fallback is meaningful.
  const kTag = event.tags.find(t => t[0] === 'k');
  const innerKind = kTag?.[1] ? Number(kTag[1]) : NaN;
  const isAddressable =
    Number.isInteger(innerKind) && innerKind >= 30000 && innerKind < 40000;

  // Try 2: Fetch via e-tag (modern format - NIP-18)
  const eTag = event.tags.find(t => t[0] === 'e');
  if (eTag && eTag[1]) {
    try {
      const { QuoteOrchestrator } = await import(
        '../services/orchestration/QuoteOrchestrator'
      );
      const { encodeNevent } = await import('../services/NostrToolsAdapter');
      // NIP-18: p-tag carries the original author pubkey, e-tag[2] is the
      // relay hint where the reposter saw the original.
      const pTag = event.tags.find(t => t[0] === 'p');
      const originalAuthor = pTag?.[1];
      const relayHint = eTag[2] || '';

      // Wrap into an nevent so QuoteOrchestrator's stage-1 hint fetch fires
      // (bare hex would skip straight to our read set, missing the relay
      // the reposter explicitly pointed at — typical cross-relay-repost
      // failure mode).
      const neventRef = encodeNevent(
        eTag[1],
        relayHint ? [relayHint] : [],
        originalAuthor
      );

      // Pass the REPOSTER's own pubkey (event.pubkey) as an extra outbound
      // fallback candidate. The reposter saw the original on their relays;
      // those are the next best guess after the original author's outbound.
      // Without this, cross-relay reposts (reposter's read set vs. original
      // author's write set don't overlap, and the original author's NIP-65
      // is incomplete or stale) hit the "Note not found" error.
      const originalEvent =
        await QuoteOrchestrator.getInstance().fetchQuotedEvent(
          `nostr:${neventRef}`,
          originalAuthor,
          [event.pubkey]
        );
      if (originalEvent) {
        return originalEvent;
      }
    } catch (error) {
      console.debug(
        '[getRepostsOriginalEvent] Failed to fetch original note via e-tag:',
        error
      );
    }
  }

  // Try 3: Addressable a-tag fallback. Critical for replaceable kinds (30311
  // live streams, 30023 articles, …): the original event id often no longer
  // exists on relays because the author published an updated version under
  // the same coordinate — only the coordinate query returns the current
  // version. Without this branch, SNV shows "Original note not found" for
  // any repost of a replaceable event older than the latest revision.
  if (isAddressable) {
    const aTag = event.tags.find(t => t[0] === 'a');
    if (aTag?.[1]) {
      try {
        const { ModuleLoader } = await import('../core/ModuleLoader');
        const { encodeNaddr } = await import('../services/NostrToolsAdapter');
        const [kindStr, pubkey, identifier] = aTag[1].split(':');
        const kindNum = Number(kindStr);
        if (!Number.isFinite(kindNum) || !pubkey || identifier === undefined) {
          // Malformed a-tag — give up.
        } else {
          const relayHint = aTag[2] || undefined;
          const naddr = encodeNaddr({
            kind: kindNum,
            pubkey,
            identifier,
            relays: relayHint ? [relayHint] : [],
          });
          type ArticlesApi =
            import('../modules/articles/contracts').ArticlesModuleApi;
          const api =
            await ModuleLoader.getInstance().ensure<ArticlesApi>('articles');
          const addressableEvent = await api?.fetchAddressableEvent(naddr);
          if (addressableEvent) {
            return addressableEvent;
          }
        }
      } catch (error) {
        console.debug(
          '[getRepostsOriginalEvent] Failed to fetch original via a-tag:',
          error
        );
      }
    }
  }

  // Fallback: Return repost itself (shouldn't happen in practice)
  console.debug(
    '[getRepostsOriginalEvent] Could not extract original event, returning repost itself'
  );
  return event;
}
