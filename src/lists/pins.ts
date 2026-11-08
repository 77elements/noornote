/**
 * pins.ts - Pinned note (kind 10001, replaceable "Pinlist")
 *
 * The user can pin ONE of their own notes to the top of their Profile View.
 * The pinned note id lives in a replaceable kind:10001 event (the de-facto
 * "Pinlist" standard — same kind used by mainstream clients), one public
 * `e` tag holding the pinned event id. Publishing a new 10001 replaces the
 * old one, so switching the pin is just a new publish; an empty list is an
 * unpublish-style clear. Fully public (no encrypted content part).
 */

import { TypedEventBus } from '../core/TypedEventBus';
import {
  fetchEvents,
  getCurrentUserPubkey,
  publishEvent,
  requireAuth,
  signEvent,
} from './relays';
import { now } from './storage';
import { SystemLogger } from '../services/SystemLogger';

const logger = SystemLogger.getInstance();

const PIN_KIND = 10001;

/** Session cache of the user's pinned note id (null = nothing pinned). */
let cachedPinnedEventId: string | null | undefined;

export interface PinnedNoteInfo {
  /** Event id of the pinned note, or null when nothing is pinned. */
  pinnedEventId: string | null;
}

/**
 * Extract the pinned event id from a kind:10001 event (first `e` tag).
 * Pure helper — exported for tests.
 */
export function getPinnedEventId(event: { tags: string[][] }): string | null {
  const eTag = event.tags.find(tag => tag[0] === 'e' && tag[1]);
  return eTag?.[1] ?? null;
}

/**
 * Fetch the user's pinned-note list (kind 10001) from relays.
 * Returns the pinned event id, or null when nothing is pinned.
 * Results are cached for the session; pass `skipCache` to force a re-fetch.
 */
export async function fetchPinnedNoteId(
  authorPubkey: string,
  skipCache: boolean = false
): Promise<string | null> {
  if (!skipCache && cachedPinnedEventId !== undefined) {
    return cachedPinnedEventId;
  }

  try {
    const events = await fetchEvents(
      [{ authors: [authorPubkey], kinds: [PIN_KIND], limit: 1 }],
      5000,
      skipCache
    );

    const pinEvent = events.sort((a, b) => b.created_at - a.created_at)[0];
    cachedPinnedEventId = pinEvent ? getPinnedEventId(pinEvent) : null;

    diagCache(authorPubkey);
    return cachedPinnedEventId;
  } catch (error) {
    logger.error('pins.ts', `Failed to fetch pin list: ${String(error)}`);
    return null;
  }
}

/**
 * Whether the given event is currently the user's pinned note
 * (cache-based; used by the note menu to pick the right label).
 */
export async function isEventPinned(eventId: string): Promise<boolean> {
  const pubkey = getCurrentUserPubkey();
  if (!pubkey) return false;
  const pinnedId = await fetchPinnedNoteId(pubkey);
  return pinnedId === eventId;
}

/**
 * Pin one of the user's own notes. Publishing a fresh replaceable kind:10001
 * with a single `e` tag replaces any previous pin (replaceable-event
 * semantics — older clients see the newest 10001 only).
 */
export async function pinNote(eventId: string): Promise<void> {
  const user = requireAuth();

  const event = {
    kind: PIN_KIND,
    created_at: now(),
    tags: [['e', eventId]],
    content: '',
    pubkey: user.pubkey,
  };

  const signed = await signEvent(event);
  if (!signed) {
    throw new Error('Failed to sign pin list event');
  }

  await publishEvent(signed);
  cachedPinnedEventId = eventId;
  diagCache(user.pubkey);

  logger.info('pins.ts', `Pinned note ${eventId.slice(0, 8)}`);
  TypedEventBus.getInstance().emit('pin:updated', { pubkey: user.pubkey });
}

/**
 * Unpin: publish an empty kind:10001 (no `e` tags) — replaces the previous
 * pin for every client reading the replaceable event.
 */
export async function unpinNote(): Promise<void> {
  const user = requireAuth();

  const event = {
    kind: PIN_KIND,
    created_at: now(),
    tags: [],
    content: '',
    pubkey: user.pubkey,
  };

  const signed = await signEvent(event);
  if (!signed) {
    throw new Error('Failed to sign pin list event');
  }

  await publishEvent(signed);
  cachedPinnedEventId = null;
  diagCache(user.pubkey);

  logger.info('pins.ts', 'Unpinned note');
  TypedEventBus.getInstance().emit('pin:updated', { pubkey: user.pubkey });
}

/** Drop the session cache (account switch / logout). */
export function clearPinCache(): void {
  cachedPinnedEventId = undefined;
}

// Account switch / logout: the cached pin belongs to the previous user.
TypedEventBus.getInstance().on('user:logout', () => clearPinCache());

function diagCache(pubkey: string): void {
  logger.info('pins.ts', `Pin cache updated for ${pubkey.slice(0, 8)}`, {
    pinned: cachedPinnedEventId?.slice(0, 8) ?? null,
  });
}
