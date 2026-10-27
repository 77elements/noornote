/**
 * BadgeDefinitionProcessor — NIP-58 Badge Definition (kind 30009)
 *
 * Badge definitions are self-contained: name, description, image and thumbs
 * live in the event's own tags (unlike kind-8 awards, which only carry the
 * definition coordinate and resolve it async). No relay fetch needed here.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';
import { getTag } from '../../../helpers/tagUtils';

export class BadgeDefinitionProcessor {
  static process(event: NostrEvent): ProcessedNote {
    const eventId = event.id;
    if (!eventId) throw new Error('Event ID is required');

    const slug = getTag(event.tags, 'd') || 'badge';
    const coordinate = `30009:${event.pubkey}:${slug}`;
    const image = getTag(event.tags, 'image');
    const thumb = getTag(event.tags, 'thumb');

    return {
      id: eventId,
      type: 'badge-definition',
      timestamp: event.created_at,
      author: { pubkey: event.pubkey },
      content: {
        // Badge definitions carry no prose content — everything is in tags.
        text: '',
        html: '',
        media: [],
        links: [],
        hashtags: [],
        quotedReferences: [],
        bolt11Invoices: [],
      },
      rawEvent: event,
      badgeData: {
        coordinate,
        slug,
        name: getTag(event.tags, 'name') || slug,
        description: getTag(event.tags, 'description') || '',
        ...(image ? { image } : {}),
        ...(thumb ? { thumb } : {}),
      },
    };
  }
}
