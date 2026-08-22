/**
 * Resolve an addressable event (NIP-33, kinds 30000–39999) from a hex event id
 * whose original version is no longer carried by any relay.
 *
 * Why this exists: replaceable events (live streams, articles, …) get
 * overwritten by the author under the same coordinate (`kind:pubkey:d-tag`).
 * Many relays keep only the latest version; older event ids become unresolvable
 * even though NIP-19 nevent links and old bookmarks still point at them. When
 * such an id is referenced by another event (typically a kind 6/16 repost or a
 * kind 1 quote) that *also* carries the coordinate as an `a` tag, we can use
 * that reference to find the current version of the replaceable event.
 *
 * Strategy:
 *   1. Subscribe to events referencing the hex id via `#e` filter (kinds 6/16,
 *      and broader as fallback).
 *   2. For each referencing event, look for an `a` tag whose coordinate matches
 *      an addressable kind (30000–39999). NIP-18 reposts of replaceable events
 *      conventionally carry both the `e` and the `a` tag.
 *   3. Resolve the coordinate through the Articles module (same path as
 *      naddr-quotes) and return the freshly-fetched current version.
 *
 * Returns `null` if no usable reference is found within the relay timeout.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { fetchNostrEvents } from './fetchNostrEvents';
import { RelayConfig } from '../services/RelayConfig';
import { ModuleLoader } from '../core/ModuleLoader';
import type { ArticlesModuleApi } from '../modules/articles/contracts';
import { encodeNaddr } from '../services/NostrToolsAdapter';

const ADDRESSABLE_KIND_MIN = 30000;
const ADDRESSABLE_KIND_MAX = 39999;

function isAddressableKind(kind: number): boolean {
  return kind >= ADDRESSABLE_KIND_MIN && kind <= ADDRESSABLE_KIND_MAX;
}

function parseCoordinate(
  coord: string
): { kind: number; pubkey: string; identifier: string } | null {
  const parts = coord.split(':');
  if (parts.length < 3) return null;
  const kind = Number(parts[0]);
  const pubkey = parts[1];
  const identifier = parts.slice(2).join(':');
  if (!Number.isFinite(kind) || !pubkey || identifier === undefined)
    return null;
  if (!isAddressableKind(kind)) return null;
  return { kind, pubkey, identifier };
}

export async function resolveAddressableFromReferences(
  hexId: string
): Promise<NostrEvent | null> {
  const relays = RelayConfig.getInstance().getReadRelays();
  if (relays.length === 0) return null;

  // Step 1: find any repost (kind 6 / 16) referencing this id. NIP-18 reposts
  // of replaceable events carry the coordinate alongside the e-tag — that's
  // what we're after. We also widen to kind 1 quotes as a last-ditch effort.
  const refResult = await fetchNostrEvents({
    relays,
    kinds: [6, 16],
    referencedEventId: hexId,
    limit: 10,
    timeout: 4000,
  });

  const referencingEvents = refResult.events;

  // Step 2: extract the first usable `a` tag coordinate.
  let resolvedCoord: ReturnType<typeof parseCoordinate> = null;
  for (const referencingEvent of referencingEvents) {
    const aTags = referencingEvent.tags
      .map(t => t[1])
      .filter((v): v is string => typeof v === 'string');
    for (const aTagValue of aTags) {
      const coord = parseCoordinate(aTagValue);
      if (coord) {
        resolvedCoord = coord;
        break;
      }
    }
    if (resolvedCoord) break;
  }

  if (!resolvedCoord) return null;

  // Step 3: fetch the current version of the addressable event.
  const naddr = encodeNaddr({
    kind: resolvedCoord.kind,
    pubkey: resolvedCoord.pubkey,
    identifier: resolvedCoord.identifier,
    relays: [],
  });

  const articlesApi =
    await ModuleLoader.getInstance().ensure<ArticlesModuleApi>('articles');
  return (await articlesApi?.fetchAddressableEvent(naddr)) ?? null;
}
