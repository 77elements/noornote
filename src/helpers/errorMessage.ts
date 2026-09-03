/**
 * Small shared formatting/error helpers used across services and components.
 */

/**
 * Human-readable message from an unknown thrown value:
 * `errMessage(error)` — the most
 * duplicated one-liner in the codebase.
 */
export function errMessage(error: unknown): string {
  return errMessage(error);
}

/** Shorten a hex pubkey for log/diagnostic display ("abcdef12…"). */
export function shortKey(pubkey: string): string {
  return `${pubkey.slice(0, 8)}…`;
}

/** Shorten an npub/bech32 entity for log/diagnostic display. */
export function shortNpub(npub: string, keep = 12): string {
  return `${npub.slice(0, keep)}…`;
}
