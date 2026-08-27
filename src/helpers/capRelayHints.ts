/**
 * Merge and cap relay hint lists for NIP-19 entities (nevent/naddr).
 * Single purpose: (primary[], fallback[], max) → deduped, capped relay hints
 *
 * Primary relays (where an event was actually seen this session) come first,
 * fallback relays (e.g. the user's write relays) fill up the remaining slots.
 * Dedupes by exact URL — near-duplicates with/without trailing slash are
 * tolerated (hints are best-effort, never authoritative).
 *
 * @example
 * capRelayHints(['wss://a'], ['wss://a', 'wss://b', 'wss://c', 'wss://d'])
 * // => ['wss://a', 'wss://b', 'wss://c']
 */

export const RELAY_HINTS_MAX = 3;

export function capRelayHints(
  primary: string[],
  fallback: string[] = [],
  max: number = RELAY_HINTS_MAX
): string[] {
  const seen = new Set<string>();
  const hints: string[] = [];

  for (const url of [...primary, ...fallback]) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    hints.push(url);
    if (hints.length >= max) break;
  }

  return hints;
}
