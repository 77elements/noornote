/**
 * Format a relay URL for display: strip the ws:// or wss:// scheme and any
 * trailing slash for a cleaner host-only label (e.g. "relay.damus.io").
 */
export function formatRelayUrl(url: string): string {
  return url.replace(/^wss?:\/\//, '').replace(/\/$/, '');
}
