/**
 * Universal Nostr Event Fetch Helper
 * Single-purpose, parametrized fetch that covers all use-cases
 * NPM-ready: Can be published as @noornote/fetch-nostr-events
 *
 * Migrated to NDK for better performance and reliability
 *
 * Use-Cases:
 * 1. Timeline (many authors, time window, kinds [1,6])
 * 2. Single event by ID (ids: [eventId], limit: 1)
 * 3. User profile (authors: [pubkey], kinds: [0], limit: 1)
 * 4. Following list (authors: [pubkey], kinds: [3], limit: 1)
 * 5. Replies to event (kinds: [1], referencedEventId)
 * 6. Load more (same as timeline but with until)
 */

import { NostrTransport } from './transport/NostrTransport';
import { type NostrEvent, type NDKFilter } from '@nostr-dev-kit/ndk';

export interface FetchNostrEventsParams {
  /** Relay URLs to fetch from */
  relays: string[];

  /** Filter: Event IDs (for fetching specific events) */
  ids?: string[];

  /** Filter: Author pubkeys */
  authors?: string[];

  /** Filter: Event kinds (1=text note, 3=contacts, 6=repost, 0=metadata) */
  kinds?: number[];

  /** Filter: Fetch events older than this timestamp */
  until?: number;

  /** Filter: Fetch events newer than this timestamp */
  since?: number;

  /** Filter: Limit number of events */
  limit?: number;

  /** Filter: Events that reference this event ID (e-tag) */
  referencedEventId?: string;

  /** Filter: Events that reference this pubkey (p-tag) */
  referencedPubkey?: string;

  /** Filter: Custom tags (e.g., { 'q': ['noteId'], 't': ['hashtag'] }) */
  tags?: Record<string, string[]>;

  /** Convenience: Time window in hours (automatically calculates since) */
  timeWindowHours?: number;

  /** Timeout in milliseconds (default: 5000) */
  timeout?: number;
}

export interface FetchNostrEventsResult {
  /** Fetched events (deduplicated by ID) */
  events: NostrEvent[];

  /** Number of relays that responded */
  relaysResponded: number;

  /** Relay URLs that failed to respond */
  failedRelays: string[];
}

/**
 * Fetch Nostr events from relays with flexible filtering
 * Uses NostrTransport (NDK-based) - auto-dedupe, auto-verify
 */
export async function fetchNostrEvents(
  params: FetchNostrEventsParams
): Promise<FetchNostrEventsResult> {
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
    tags,
    timeWindowHours,
    timeout = 5000,
  } = params;

  // Validate
  if (!relays || relays.length === 0) {
    throw new Error(
      'fetchNostrEvents: relays parameter is required and must not be empty'
    );
  }

  try {
    // Construct NDK filter
    const filter: NDKFilter = {};

    if (ids) filter.ids = ids;
    if (authors) filter.authors = authors;
    if (kinds) filter.kinds = kinds;
    if (until) filter.until = until;
    if (limit) filter.limit = limit;

    // Time window convenience: calculate since from until or now
    if (timeWindowHours !== undefined) {
      const timeWindowSeconds = timeWindowHours * 3600;
      const referenceTime = until || Math.floor(Date.now() / 1000);
      filter.since = referenceTime - timeWindowSeconds;
    } else if (since !== undefined) {
      filter.since = since;
    }

    // Referenced event (e-tag) - for replies/quotes
    if (referencedEventId) {
      filter['#e'] = [referencedEventId];
    }

    // Referenced pubkey (p-tag) - for mentions
    if (referencedPubkey) {
      filter['#p'] = [referencedPubkey];
    }

    // Custom tags (e.g., 'q' for quoted reposts, 't' for hashtags)
    if (tags) {
      Object.entries(tags).forEach(([tagName, tagValues]) => {
        filter[`#${tagName}`] = tagValues;
      });
    }

    // Fetch via NostrTransport (NDK handles dedupe, verification, timeout)
    const transport = NostrTransport.getInstance();
    const events = await transport.fetch(
      relays,
      [filter],
      timeout,
      false,
      'fetchNostrEvents'
    );

    // Sort by created_at (newest first)
    events.sort((a, b) => b.created_at - a.created_at);

    return {
      events,
      relaysResponded: relays.length,
      failedRelays: [],
    };
  } catch (error) {
    console.error('fetchNostrEvents error:', error);
    return {
      events: [],
      relaysResponded: 0,
      failedRelays: relays,
    };
  }
}
