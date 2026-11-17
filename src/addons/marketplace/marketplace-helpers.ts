/**
 * Marketplace Helpers — parsing/formatting facade.
 *
 * The NIP-99 listing metadata logic lives in the core helper
 * `src/helpers/listingMetadata.ts` so the note processing pipeline
 * (ListingProcessor/ListingRenderer) can use it synchronously without
 * importing addon code. This module re-exports it so existing addon
 * call sites keep working unchanged.
 */

export {
  parseListingMetadata,
  formatPrice,
} from '../../helpers/listingMetadata';
export type { ListingMetadata } from '../../helpers/listingMetadata';

import { encodeNaddr } from '../../services/NostrToolsAdapter';
import {
  formatPrice,
  parseListingMetadata,
  type ListingMetadata,
} from '../../helpers/listingMetadata';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

/**
 * Card-header basics shared by every listing card renderer (timeline
 * injection + my-listings row): parsed NIP-99 metadata, the canonical
 * naddr of the listing (no relay hints), the formatted price string and
 * the first image URL (empty when the listing has none).
 */
export function getListingCardBasics(event: NostrEvent): {
  meta: ListingMetadata;
  naddr: string;
  priceDisplay: string;
  firstImage: string;
} {
  const meta = parseListingMetadata(event);
  const naddr = encodeNaddr({
    kind: 30402,
    pubkey: event.pubkey,
    identifier: meta.identifier,
    relays: [],
  });
  const priceDisplay = formatPrice(
    meta.price,
    meta.priceCurrency,
    meta.priceFrequency
  );
  const firstImage = meta.images[0] || '';
  return { meta, naddr, priceDisplay, firstImage };
}
