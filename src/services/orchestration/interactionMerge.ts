/**
 * interactionMerge — pure classification + dedup merge for live interaction
 * events on one note (kind 7 reactions, kind 9735 zap receipts, kind 6
 * reposts/quotes). Shared by ReactionsOrchestrator's 30s poll and the live
 * subscription so both paths maintain the same detailedStatsCache.
 *
 * Pure logic — no imports, unit-tested in interactionMerge.test.ts.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';

/** Classifiable event buckets on one note (mirrors DetailedStats). */
export interface InteractionEventBuckets {
  reactionEvents: NostrEvent[];
  zapEvents: NostrEvent[];
  repostEvents: NostrEvent[];
  quotedEvents: NostrEvent[];
}

/**
 * Classify one incoming event into its bucket. kind 6 counts as a QUOTE when
 * it carries a `q`- or `a`-tag referencing the note; otherwise it is a plain
 * repost. Anything else (non-7/9735/6) is ignored.
 */
function classify(
  event: NostrEvent,
  noteId: string,
  isAddressableNote: boolean
): 'reaction' | 'zap' | 'repost' | 'quote' | null {
  if (event.kind === 7) return 'reaction';
  if (event.kind === 9735) return 'zap';
  if (event.kind === 6) {
    const isQuote = event.tags.some(
      tag => (tag[0] === 'q' || tag[0] === 'a') && tag[1] === noteId
    );
    if (isQuote) return 'quote';
    // Hex notes can also be quoted via an #e-tagged kind 6 whose content
    // embeds the note — NIP-18 reposts of a quote carry the q-tag though,
    // so the tag check above is the reliable path. Plain repost otherwise.
    if (!isAddressableNote && event.content.includes('nostr:')) {
      return 'quote';
    }
    return 'repost';
  }
  return null;
}

/**
 * Merge new events into the cached buckets: dedup by event id, classify by
 * kind/tag, and return the updated buckets (mutates `cached` in place for the
 * orchestrator's cache, but the returned object is the same reference).
 */
export function mergeInteractionEvents(
  cached: InteractionEventBuckets,
  newEvents: NostrEvent[],
  noteId: string
): InteractionEventBuckets {
  const isAddressableNote = noteId.includes(':');
  const seen = new Set<string>();
  for (const bucket of [
    cached.reactionEvents,
    cached.zapEvents,
    cached.repostEvents,
    cached.quotedEvents,
  ]) {
    for (const ev of bucket) if (ev.id) seen.add(ev.id);
  }

  for (const event of newEvents) {
    if (!event.id || seen.has(event.id)) continue;
    seen.add(event.id);

    switch (classify(event, noteId, isAddressableNote)) {
      case 'reaction':
        cached.reactionEvents.push(event);
        break;
      case 'zap':
        cached.zapEvents.push(event);
        break;
      case 'quote':
        cached.quotedEvents.push(event);
        break;
      case 'repost':
        cached.repostEvents.push(event);
        break;
      default:
        break;
    }
  }

  return cached;
}
