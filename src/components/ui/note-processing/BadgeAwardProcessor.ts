/**
 * BadgeAwardProcessor — NIP-58 Badge Award (kind 8)
 *
 * Parses the a-tag (badge definition coordinate) and p-tags (awardees)
 * from a kind:8 event. The badge definition (name, image) is resolved
 * async at render time by BadgeAwardRenderer via BadgeOrchestrator.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';

export class BadgeAwardProcessor {
  static process(event: NostrEvent): ProcessedNote {
    const eventId = event.id;
    if (!eventId) throw new Error('Event ID is required');

    const aTag = event.tags.find(t => t[0] === 'a');
    const badgeCoordinate = aTag?.[1] ?? '';
    const awardees = event.tags
      .filter(t => t[0] === 'p' && t[1])
      .map(t => t[1]!) as string[];

    const parts = badgeCoordinate.split(':');
    const slug = parts.length >= 3 ? parts.slice(2).join(':') : 'badge';

    return {
      id: eventId,
      type: 'badge-award',
      timestamp: event.created_at,
      author: { pubkey: event.pubkey },
      content: {
        text: event.content || '',
        html: '',
        media: [],
        links: [],
        hashtags: [],
        quotedReferences: [],
        bolt11Invoices: [],
      },
      rawEvent: event,
      badgeData: {
        coordinate: badgeCoordinate,
        slug,
        awardees,
      },
    };
  }
}
