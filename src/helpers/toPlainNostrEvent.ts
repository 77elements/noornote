import type { NostrEvent } from '@nostr-dev-kit/ndk';

/**
 * Reduce any event object to the seven canonical NIP-01 fields.
 *
 * An event that still carries its NDK wrapper holds a live `relay` / `onRelays`
 * reference, and `NDKRelay.connectivity.ndkRelay` points back at the relay — a
 * circular structure. `JSON.stringify` on such an object throws
 * ("Converting circular structure to JSON"), which silently broke the Raw Event
 * modal and made NIP-18 reposts fail to publish for those (rare) notes.
 *
 * Only `id`, `pubkey`, `created_at`, `kind`, `tags`, `content` and `sig` are
 * part of the signed event; everything else is NDK-internal noise. Stripping to
 * them makes serialisation safe and, for reposts, embeds exactly the verifiable
 * original event. Works for both NDKEvent instances and plain event objects.
 */
export function toPlainNostrEvent(event: NostrEvent): NostrEvent {
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
  } as NostrEvent;
}
