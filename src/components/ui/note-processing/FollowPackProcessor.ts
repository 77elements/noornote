/**
 * FollowPackProcessor - Follow Pack processor (kind 39089)
 * Processes follow pack events for timeline display as an nn-card.
 * Full rendering of members/ISL/replies is handled by FollowPackDetailView.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';

export class FollowPackProcessor {
  static process(event: NostrEvent): ProcessedNote {
    const eventId = event.id;
    if (!eventId) {
      throw new Error('Event ID is required');
    }

    return {
      id: eventId,
      type: 'follow-pack',
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
