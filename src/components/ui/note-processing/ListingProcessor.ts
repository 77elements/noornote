/**
 * ListingProcessor - NIP-99 classified listing processor (kind 30402)
 * Processes listing events for display as a listing card in TV/PV/SNV.
 * Tag/price parsing happens in ListingRenderer via helpers/listingMetadata.
 * Full detail view (gallery, buy actions) is handled by ListingView (addon route).
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';

export class ListingProcessor {
  static process(event: NostrEvent): ProcessedNote {
    const eventId = event.id;
    if (!eventId) {
      throw new Error('Event ID is required');
    }

    return {
      id: eventId,
      type: 'listing',
      timestamp: event.created_at,
      author: { pubkey: event.pubkey },
      content: {
        text: '',
        html: '',
        media: [],
        links: [],
        hashtags: [],
        quotedReferences: [],
        bolt11Invoices: [],
      },
      rawEvent: event,
    };
  }
}
