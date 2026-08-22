/**
 * Zap Utility Helpers
 * Shared functions for parsing NIP-57 zap receipts (Kind 9735)
 * Used by ZapsList, ZapStatsService, AnalyticsModal, ReactionsOrchestrator
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';

/**
 * Parsed zap request data extracted from a Kind 9735 event's description tag
 */
interface ZapRequestData {
  pubkey: string;
  message: string;
}

/**
 * Parse the embedded zap request from a zap receipt's description tag.
 * Returns pubkey and message from the zap request JSON, or null on failure.
 */
function parseZapRequest(zapEvent: NostrEvent): ZapRequestData | null {
  const descTag = zapEvent.tags.find(t => t[0] === 'description');
  if (!descTag?.[1]) return null;

  try {
    const zapRequest = JSON.parse(descTag[1]);
    return {
      pubkey: zapRequest.pubkey || '',
      message: zapRequest.content || '',
    };
  } catch {
    return null;
  }
}

/**
 * Extract the actual zapper's pubkey from a Kind 9735 zap receipt.
 * Priority: P tag (NIP-57 standard) > description tag (zap request) > event.pubkey fallback
 *
 * NOTE for anonymous zaps: the pubkey returned here is the ephemeral throwaway
 * key. Callers that want to render anonymous zaps differently should check
 * `isZapAnonymous(zapEvent)` first and skip profile-lookup / avatar fetch.
 */
export function extractZapperPubkey(zapEvent: NostrEvent): string {
  const senderTag = zapEvent.tags.find(t => t[0] === 'P');
  if (senderTag?.[1]) return senderTag[1];

  const zapRequest = parseZapRequest(zapEvent);
  if (zapRequest?.pubkey) return zapRequest.pubkey;

  return zapEvent.pubkey;
}

/**
 * Check whether a Kind 9735 zap receipt's embedded zap request carries an
 * `anon` tag — the de-facto convention (PR #1271 / Damus / Amethyst / Wisp)
 * marking the zap as anonymous. Empty tag value = pure-anonymous (throwaway
 * key), non-empty value = DIP-03 private zap (encrypted inner kind 9733).
 * Both cases mean: don't render the ephemeral pubkey as a real user.
 */
export function isZapAnonymous(zapEvent: NostrEvent): boolean {
  const descTag = zapEvent.tags.find(t => t[0] === 'description');
  if (!descTag?.[1]) return false;
  try {
    const zapRequest = JSON.parse(descTag[1]);
    return (
      Array.isArray(zapRequest.tags) &&
      zapRequest.tags.some((t: string[]) => t[0] === 'anon')
    );
  } catch {
    return false;
  }
}

/**
 * Extract the zap message (content) from a Kind 9735 zap receipt's embedded zap request.
 */
export function extractZapMessage(zapEvent: NostrEvent): string {
  return parseZapRequest(zapEvent)?.message || '';
}

/**
 * Parse a bolt11 Lightning invoice to extract the amount in satoshis.
 * Handles all standard multipliers: m (milli), u (micro), n (nano), p (pico).
 */
export function parseBolt11Amount(invoice: string): number {
  const match = invoice.match(/^ln(bc|tb)(\d+)([munp]?)/i);
  if (!match?.[2]) return 0;

  const amount = parseInt(match[2]);
  const multiplier = match[3]?.toLowerCase();

  let millisats: number;
  switch (multiplier) {
    case 'm':
      millisats = amount * 100_000_000;
      break;
    case 'u':
      millisats = amount * 100_000;
      break;
    case 'n':
      millisats = amount * 100;
      break;
    case 'p':
      millisats = amount * 0.1;
      break;
    default:
      millisats = amount * 100_000_000_000;
      break;
  }

  return Math.floor(millisats / 1000);
}

/**
 * Extract the bolt11 amount in sats from a zap event's bolt11 tag.
 * Convenience wrapper that finds the tag and parses it in one step.
 */
export function getZapAmountSats(zapEvent: NostrEvent): number {
  const bolt11Value = zapEvent.tags.find(t => t[0] === 'bolt11')?.[1];
  return bolt11Value ? parseBolt11Amount(bolt11Value) : 0;
}

/**
 * Format a number with comma thousands separator (US format).
 * Example: 1500 -> "1,500", 1000000 -> "1,000,000"
 */
export function formatNumberWithCommas(num: number): string {
  return num.toLocaleString('en-US');
}
