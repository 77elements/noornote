/**
 * Browser read-relay connection cap (pure logic, no imports).
 *
 * Browsers budget WebSocket connections globally across ALL tabs of the
 * origin (~255 in Chromium, ~200 in Firefox); every connected relay costs
 * one socket per tab. 32 keeps even heavy multi-tab use far under every
 * budget while preserving the user's own relays (aggregator redundancy
 * trims first). The Electron desktop app opens one window — no shared
 * budget, no cap.
 */

export const BROWSER_MAX_READ_RELAYS = 32;

/**
 * Trim a read-relay list to `cap` entries. `cap === null` = uncapped
 * (desktop). Pure so the platform-independent ordering rule is testable:
 * the caller builds the list with user relays first and aggregator
 * redundancy last, so a plain slice keeps what the user chose explicitly.
 */
export function capReadRelays(urls: string[], cap: number | null): string[] {
  if (cap === null || urls.length <= cap) return urls;
  return urls.slice(0, cap);
}
