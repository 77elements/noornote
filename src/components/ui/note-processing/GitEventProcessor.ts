/**
 * GitEventProcessor - NIP-34 Git events (lightweight cards)
 * Kinds: 1617 (Patch), 1618 (PR), 1621 (Issue), 1630-1633 (Status), 30617 (Repo Announcement)
 * Full repo/PR/issue UI is out of scope — cards link to gitworkshop.dev.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';

export class GitEventProcessor {
  static process(event: NostrEvent): ProcessedNote {
    const eventId = event.id;
    if (!eventId) {
      throw new Error('Event ID is required');
    }

    return {
      id: eventId,
      type: 'git-event',
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
