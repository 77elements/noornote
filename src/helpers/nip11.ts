/**
 * nip11.ts - NIP-11 Relay Information Document helper
 *
 * Fetches a relay's information document (HTTP GET on the relay's http(s)
 * URL with `Accept: application/nostr+json`) and extracts the advertised
 * `supported_nips` list. Per NIP-11 the document is OPTIONAL and purely
 * self-declared: a missing list means "no info available", NOT "unsupported".
 * Browser CORS restrictions frequently block the fetch even when the relay
 * supports NIP-11 — callers must degrade gracefully.
 */

/** Short names for common NIPs shown next to the number in the UI. */
const NIP_NAMES: Record<number, string> = {
  1: 'Events',
  2: 'Contacts',
  3: 'OpenTimestamps',
  4: 'Encrypted DMs (legacy)',
  9: 'Deletion',
  11: 'Relay Info',
  12: 'Generic Tag Query',
  13: 'Difficulties',
  14: 'Subject',
  15: 'Marketplace',
  16: 'Events Treatment',
  17: 'DMs (NIP-44)',
  18: 'Reposts',
  22: 'Comments',
  23: 'Long-form',
  24: 'Extra Metadata',
  25: 'Reactions',
  26: 'Redirects',
  28: 'Public Messages',
  29: 'Relay-based Groups',
  30: 'Custom Emoji',
  31: 'Deals',
  32: 'Labeling',
  33: 'Parameterized Replaceable',
  34: 'git Stuff',
  35: 'Trust Providers',
  36: 'Sensitive Content',
  38: 'User Statuses',
  39: 'Live Communities',
  40: 'Expiration',
  42: 'Authentication',
  44: 'Versioned Encryption',
  45: 'NIP-46 Wallets',
  46: 'Nostr Wallet Connect',
  47: 'Wallet Connect Info',
  49: 'Private Key Encryption',
  50: 'Search Capability',
  51: 'Lists',
  52: 'Calendar',
  53: 'Live Activities',
  54: 'Wiki',
  55: 'Android Concepts',
  56: 'Reporting',
  57: 'Lightning Zaps',
  58: 'Badges',
  59: 'Gift Wrap',
  60: 'Quotas',
  61: 'Nested Lists',
  62: 'Request To Vanish',
  64: 'Chess',
  65: 'Relay List Metadata',
  66: 'Blob Storage',
  68: 'Picture Events',
  69: 'Peer-to-peer Order Events',
  70: 'Protected Events',
  71: 'Video Events',
  72: 'Moderated Communities',
  75: 'Zap Goals',
  77: 'Negentropy',
  78: 'App-Specific Data',
  82: 'Media Attachments',
  84: 'VoIP',
  85: 'Relay Network Query',
  86: 'Relay Listing',
  87: 'Markdown Formatting',
  89: 'Recommended Application Data',
  90: 'Data Vending Machines',
  92: 'Media Unencrypted',
  94: 'File Metadata',
  96: 'Moderation Flags',
  98: 'Chronicles',
};

export interface Nip11InfoResult {
  /** Advertised NIP numbers, ascending. Null when unavailable. */
  supportedNips: number[] | null;
}

const sessionCache = new Map<string, number[] | null>();

/**
 * Convert a ws(s):// relay URL to its http(s):// NIP-11 endpoint
 * (same conversion as RelayRateLimitGuard).
 */
export function relayUrlToHttpUrl(relayUrl: string): string {
  return relayUrl.startsWith('wss://')
    ? relayUrl.replace('wss://', 'https://')
    : relayUrl.replace('ws://', 'http://');
}

/**
 * Fetch the relay's supported NIPs (NIP-11). Cached per session.
 * Returns null when the relay offers no info document or CORS blocks it.
 */
export async function fetchSupportedNips(
  relayUrl: string
): Promise<number[] | null> {
  if (sessionCache.has(relayUrl)) {
    return sessionCache.get(relayUrl) ?? null;
  }

  try {
    const res = await fetch(relayUrlToHttpUrl(relayUrl), {
      headers: { Accept: 'application/nostr+json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      sessionCache.set(relayUrl, null);
      return null;
    }

    // NIP-11 response is untrusted JSON — validate the one field we use.
    const info = (await res.json()) as { supported_nips?: unknown };
    const nips = info?.supported_nips;
    if (
      !Array.isArray(nips) ||
      !nips.every(n => typeof n === 'number' && Number.isInteger(n))
    ) {
      sessionCache.set(relayUrl, null);
      return null;
    }

    const sorted = (nips as number[]).slice().sort((a, b) => a - b);
    sessionCache.set(relayUrl, sorted);
    return sorted;
  } catch {
    // No NIP-11 / CORS-restricted / timeout — non-fatal.
    sessionCache.set(relayUrl, null);
    return null;
  }
}

/**
 * Format a NIP number for display: "1 (Events)", or just "123" when the
 * number has no known short name.
 */
export function formatNip(nip: number): string {
  const name = NIP_NAMES[nip];
  return name ? `${nip} (${name})` : String(nip);
}
