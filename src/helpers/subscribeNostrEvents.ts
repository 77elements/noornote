/**
 * Universal Nostr Event Subscription Helper
 * Migrated to NDK via NostrTransport
 *
 * Use-Cases:
 * 1. Subscribe to profile updates (kind 0)
 * 2. Subscribe to new timeline events (kinds [1, 6])
 * 3. Subscribe to replies (kind 1, e-tag)
 * 4. Subscribe to mentions (kind 1, p-tag)
 */

import { NostrTransport } from '../services/transport/NostrTransport';
import { type NostrEvent, type NDKFilter } from '@nostr-dev-kit/ndk';

export interface SubscribeNostrEventsParams {
  /** Relay URLs to subscribe to */
  relays: string[];

  /** Filter: Event IDs */
  ids?: string[];

  /** Filter: Author pubkeys */
  authors?: string[];

  /** Filter: Event kinds */
  kinds?: number[];

  /** Filter: Events older than this timestamp */
  until?: number;

  /** Filter: Events newer than this timestamp */
  since?: number;

  /** Filter: Limit number of events */
  limit?: number;

  /** Filter: Events that reference this event ID (e-tag) */
  referencedEventId?: string;

  /** Filter: Events that reference this pubkey (p-tag) */
  referencedPubkey?: string;

  /** Callback for each event received */
  onEvent: (event: NostrEvent) => void;

  /** Callback when EOSE (End Of Stored Events) is reached */
  onEose?: () => void;

  /** Auto-close subscription after milliseconds (optional) */
  autoCloseAfterMs?: number;
}

/**
 * Subscribe to Nostr events via NostrTransport (NDK)
 * Returns unsubscribe function
 */
export function subscribeNostrEvents(
  params: SubscribeNostrEventsParams
): () => void {
  const {
    relays,
    ids,
    authors,
    kinds,
    until,
    since,
    limit,
    referencedEventId,
    referencedPubkey,
    onEvent,
    onEose,
    autoCloseAfterMs,
  } = params;

  // Validate
  if (!relays || relays.length === 0) {
    throw new Error(
      'subscribeNostrEvents: relays parameter is required and must not be empty'
    );
  }

  if (!onEvent) {
    throw new Error('subscribeNostrEvents: onEvent callback is required');
  }

  // Construct NDK filter
  const filter: NDKFilter = {};

  if (ids) filter.ids = ids;
  if (authors) filter.authors = authors;
  if (kinds) filter.kinds = kinds;
  if (until) filter.until = until;
  if (since) filter.since = since;
  if (limit) filter.limit = limit;

  // Referenced event (e-tag)
  if (referencedEventId) {
    filter['#e'] = [referencedEventId];
  }

  // Referenced pubkey (p-tag)
  if (referencedPubkey) {
    filter['#p'] = [referencedPubkey];
  }

  // Subscribe via NostrTransport
  const transport = NostrTransport.getInstance();

  // Track subscription state
  let subCloser: { close: () => void } | null = null;
  let isUnsubscribed = false;
  let autoCloseTimer: number | undefined;

  // Build callbacks object - only include onEose if defined
  const callbacks: {
    onEvent: (event: NostrEvent, relay: string) => void;
    onEose?: () => void;
  } = {
    onEvent: (event: NostrEvent, _relay: string) => onEvent(event),
  };
  if (onEose !== undefined) {
    callbacks.onEose = onEose;
  }

  // Start subscription (async)
  void transport.subscribe(relays, [filter], callbacks).then(closer => {
    if (isUnsubscribed) {
      // Already unsubscribed before subscription started
      closer.close();
      return;
    }
    subCloser = closer;

    // Set up auto-close timer after subscription is established
    if (autoCloseAfterMs !== undefined && autoCloseAfterMs > 0) {
      autoCloseTimer = window.setTimeout(() => {
        closer.close();
      }, autoCloseAfterMs);
    }
  });

  // Return unsubscribe function
  return () => {
    isUnsubscribed = true;
    if (autoCloseTimer) {
      clearTimeout(autoCloseTimer);
    }
    if (subCloser) {
      subCloser.close();
    }
  };
}
