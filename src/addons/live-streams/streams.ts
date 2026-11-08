/**
 * Live Streams — shared kind 30311 fetch helpers.
 *
 * One code path for the addon page list (paged, newest first) and the
 * sidebar widget (followed users only). Fetching goes through
 * lists/relays.fetchEvents (NostrTransport) — never NDK directly.
 */

import type { NostrEvent, NDKFilter, NDKKind } from '@nostr-dev-kit/ndk';
import { fetchEvents } from '../../lists/relays';
import {
  getLiveStreamStatus,
  type LiveStreamStatus,
} from '../../helpers/getLiveStreamStatus';
import { getLiveStreamHost } from '../../helpers/getLiveStreamHost';
import { encodeNaddr } from '../../services/NostrToolsAdapter';

export interface LiveStreamItem {
  event: NostrEvent;
  /** bech32 naddr (no nostr: prefix) — deep-links to the detail route and zap.stream */
  naddr: string;
  /** Real streamer pubkey (provider-signed events resolve to the p-tag host) */
  host: string;
  status: LiveStreamStatus;
  title: string;
  image: string;
  /** HLS URL of the stream (empty when absent) */
  streaming: string;
  createdAt: number;
}

export interface LiveStreamsPage {
  /** New, previously-unseen items (coordinate not in `seen`), newest first */
  items: LiveStreamItem[];
  /**
   * `until` cursor for the next page: min created_at over ALL fetched events
   * (including deduped older versions of replaceable events), minus 1.
   * null when the page came back empty.
   */
  nextUntil: number | null;
}

/** Stable coordinate for a 30311 (replaceable per pubkey + d-tag). */
function coordinateOf(event: NostrEvent): string | null {
  const d = event.tags.find(t => t[0] === 'd')?.[1];
  if (!d) return null;
  return `${event.pubkey}:${d}`;
}

/**
 * Fetch one page of kind 30311 live-activity events (zap.stream et al.),
 * deduplicated by coordinate, sorted newest first.
 *
 * @param opts.until exclusive lower time bound (previous page's cursor)
 * @param opts.seen coordinates already displayed — their events are filtered out
 */
export async function fetchLiveStreamsPage(
  opts: { limit?: number; until?: number; seen?: Set<string> } = {}
): Promise<LiveStreamsPage> {
  const limit = opts.limit ?? 20;
  const filter: NDKFilter = { kinds: [30311 as NDKKind], limit };
  if (opts.until !== undefined) filter.until = opts.until;

  const events = await fetchEvents([filter], 8000);
  if (events.length === 0) {
    return { items: [], nextUntil: null };
  }

  const seen = opts.seen ?? new Set<string>();
  const byNewest = new Map<string, NostrEvent>();
  let oldestFetched = Infinity;

  for (const event of events) {
    const coordinate = coordinateOf(event);
    if (!coordinate) continue;
    oldestFetched = Math.min(oldestFetched, event.created_at ?? 0);

    const existing = byNewest.get(coordinate);
    if (!existing || (event.created_at ?? 0) > (existing.created_at ?? 0)) {
      byNewest.set(coordinate, event);
    }
  }

  const items = [...byNewest.values()]
    .filter(event => {
      const coordinate = coordinateOf(event);
      return coordinate !== null && !seen.has(coordinate);
    })
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
    .map(event => {
      const tags = event.tags;
      const getTag = (name: string) => tags.find(t => t[0] === name)?.[1] || '';
      const dTag = getTag('d');
      return {
        event,
        naddr: encodeNaddr({
          kind: event.kind ?? 30311,
          pubkey: event.pubkey,
          identifier: dTag,
          relays: [],
        }),
        host: getLiveStreamHost(event),
        status: getLiveStreamStatus(event),
        title: getTag('title'),
        image: getTag('image'),
        streaming: getTag('streaming'),
        createdAt: event.created_at ?? 0,
      } satisfies LiveStreamItem;
    });

  for (const item of items) {
    const coordinate = coordinateOf(item.event);
    if (coordinate) seen.add(coordinate);
  }

  return {
    items,
    nextUntil: oldestFetched === Infinity ? null : oldestFetched - 1,
  };
}
