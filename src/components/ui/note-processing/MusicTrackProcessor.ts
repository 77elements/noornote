/**
 * MusicTrackProcessor — kind 36787 "Music Track" (podtunes/nostria/Wavlake
 * convention, see the Nostr Event Kinds Registry). Self-contained addressable
 * metadata: title/url/artist/album/duration/… live in the tags, `content` may
 * hold lyrics/credits. Display-only: NoorNote renders tracks, it does not
 * author them.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';
import { ContentProcessor } from '../../../services/ContentProcessor';
import { parseMusicTrack } from '../../../helpers/parseMusicTrack';

export class MusicTrackProcessor {
  private static contentProcessor = ContentProcessor.getInstance();

  static process(event: NostrEvent): ProcessedNote {
    const eventId = event.id;
    if (!eventId) throw new Error('Event ID is required');

    const processedContent =
      MusicTrackProcessor.contentProcessor.processContentWithTags(
        event.content,
        event.tags
      );

    const trackData = parseMusicTrack(event);

    return {
      id: eventId,
      type: 'music-track',
      timestamp: event.created_at,
      author: { pubkey: event.pubkey },
      content: processedContent,
      rawEvent: event,
      ...(trackData ? { musicTrack: trackData } : {}),
    };
  }
}
