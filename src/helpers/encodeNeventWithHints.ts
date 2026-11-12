/**
 * Encode an event as nevent WITH NIP-19 hints (relay hints + author).
 *
 * Relay hints are the "seen on" relays of this session (NostrTransport), so a
 * re-opened /note/<nevent> URL (browser reload, shared link) can query exactly
 * the relays that actually carried the event — instead of relying on the
 * opener's own read relays, which may not replicate it. Author is embedded for
 * outbox-style fallback lookups. This is what other clients (e.g. Jumble)
 * encode, and the reason their deep links reload instantly.
 *
 * Without hints, a deep link to a barely-replicated note fails to reload
 * ("Note not found") even though clicking it in-app works — the click path has
 * the event in the cache, the reload does not.
 *
 * Falls back to a hint-less nevent when the event was not seen on any relay
 * this session (e.g. loaded purely from the local store).
 *
 * @example
 * encodeNeventWithHints(event) // => "nevent1qqs… (id + ≤3 relay hints + author)"
 */

import { encodeNevent, type Event } from '../services/NostrToolsAdapter';
import { NostrTransport } from '../services/transport/NostrTransport';

/** Max relay hints encoded into one nevent (more is URL bloat; NIP-19 wants "a few"). */
const MAX_HINT_RELAYS = 3;

export function encodeNeventWithHints(
  event: Pick<Event, 'id' | 'pubkey'>
): string {
  if (!event.id) {
    // No id — nothing to encode meaningfully; let the adapter throw its usual
    // error so callers hit their existing error handling.
    return encodeNevent('', [], event.pubkey);
  }
  const relays = NostrTransport.getInstance()
    .getEventRelays(event.id)
    .slice(0, MAX_HINT_RELAYS);
  return encodeNevent(event.id, relays, event.pubkey);
}
