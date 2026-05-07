import { decodeNip19 } from '../services/NostrToolsAdapter';

/**
 * Tolerant pubkey resolver for user-supplied data attributes.
 *
 * Accepts:
 *   - 64-char lowercase/uppercase hex → returned as lowercase hex
 *   - bech32 npub                     → decoded to hex
 *   - empty / whitespace / invalid    → fallback
 *
 * Used by NosPress mount slots (`articlesListMount`, `weblogMount`, …)
 * where `data-pubkey` overrides the page owner. Non-throwing by design —
 * a malformed attr falls back instead of breaking the render.
 */
export function resolvePubkey(raw: string | undefined, fallback: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return fallback;
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  try {
    const decoded = decodeNip19(trimmed);
    if (decoded.type === 'npub') return decoded.data as string;
  } catch { /* fall through */ }
  return fallback;
}
