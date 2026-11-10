/**
 * CommunityDefinitionProcessor — Communikeys community definition (kind 32222)
 *
 * Community definitions are self-contained: name, description, picture,
 * website and relays live in the event's own tags (content is empty), so the
 * card renders synchronously — no fetch. Community definitions are
 * deliberately NOT fetched into timelines (metadata event, like NIP-58 badge
 * definitions); they reach users via links, quotes and reposts.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';

export class CommunityDefinitionProcessor {
  static process(event: NostrEvent): ProcessedNote {
    const eventId = event.id;
    if (!eventId) throw new Error('Event ID is required');

    return {
      id: eventId,
      type: 'community-definition',
      timestamp: event.created_at,
      author: { pubkey: event.pubkey },
      content: {
        // Community definitions carry no prose content — everything is tags.
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
