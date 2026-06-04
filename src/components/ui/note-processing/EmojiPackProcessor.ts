/**
 * EmojiPackProcessor - NIP-30 custom emoji set processor (kind 30030).
 * Processes emoji-pack events for display as an nn-card (title + emoji grid).
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';

export class EmojiPackProcessor {
  static process(event: NostrEvent): ProcessedNote {
    const eventId = event.id;
    if (!eventId) {
      throw new Error('Event ID is required');
    }

    return {
      id: eventId,
      type: 'emoji-pack',
      timestamp: event.created_at,
      author: { pubkey: event.pubkey },
      content: {
        text: '',
        html: '',
        media: [],
        links: [],
        hashtags: [],
        quotedReferences: [],
        bolt11Invoices: []
      },
      rawEvent: event
    };
  }
}
