/**
 * Fanfares-style gated premium note helpers (NIP-108-2.0 evolution).
 *
 * Event shape (verified live on wss://fanfares.nostr1.com):
 *   kind 1, tags: ["d", uuid], ["encrypted", "aes-256-gcm", blob],
 *   ["price", N, "SATS"], ["zap", author, relay, N], ["referral", pct]
 * The public `content` carries a teaser that ENDS with a self-referential
 * CTA: "⚡Zap N sats to unlock this note on" + the fanfares.io/naddr/<naddr>
 * URL whose naddr encodes THE SAME event — rendering it as a quote reference
 * recurses forever (the renderer stack-overflow / TV crash source).
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { encodeNaddr } from '../services/NostrToolsAdapter';

/** Gated premium note: AES-256-GCM encrypted payload + a sat price tag. */
export function isGatedNoteEvent(event: NostrEvent): boolean {
  const encrypted = event.tags?.find(tag => tag[0] === 'encrypted');
  const price = event.tags?.find(tag => tag[0] === 'price');
  return (
    !!encrypted &&
    encrypted[1] === 'aes-256-gcm' &&
    !!price &&
    /^\d+$/.test(price[1] ?? '')
  );
}

/** Unlock price in sats, or null for non-gated events. */
export function getGatedNotePrice(event: NostrEvent): number | null {
  if (!isGatedNoteEvent(event)) return null;
  const price = event.tags?.find(tag => tag[0] === 'price')?.[1];
  const parsed = parseInt(price ?? '', 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Remove the trailing self-referential CTA block ("⚡[ ]Zap N sats to unlock
 * this note on" + the fanfares.io/naddr/<naddr> URL) from the teaser content.
 * Content without the CTA is returned untouched.
 */
export function stripGatedNoteCta(content: string): string {
  return content
    .replace(
      /\s*⚡\s*Zap\s+\d+\s+sats\s+to\s+unlock\s+this\s+note\s+on\s*\n?\s*https:\/\/fanfares\.io\/naddr\/[a-z0-9]+\s*$/i,
      ''
    )
    .trimEnd();
}

/**
 * Canonical fanfares.io URL for the event: the coordinate (kind + pubkey +
 * d-tag) re-encoded as an naddr. Null when the event has no d-tag.
 */
export function buildFanfaresUrl(event: NostrEvent): string | null {
  const identifier = event.tags?.find(tag => tag[0] === 'd')?.[1];
  if (!event.pubkey || !identifier) return null;
  try {
    const naddr = encodeNaddr({
      kind: event.kind ?? 1,
      pubkey: event.pubkey,
      identifier,
      relays: [],
    });
    return `https://fanfares.io/naddr/${naddr}`;
  } catch {
    return null;
  }
}
