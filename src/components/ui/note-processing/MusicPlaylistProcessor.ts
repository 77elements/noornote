/**
 * MusicPlaylistProcessor — kind 34139 "Music Playlist" (albums/sets on
 * podtunes/nostria etc.). Carries only title/image plus `a`-tag references to
 * kind-36787 tracks; the renderer resolves those lazily.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';
import { ContentProcessor } from '../../../services/ContentProcessor';
import { parseMusicPlaylist } from '../../../helpers/parseMusicTrack';

export class MusicPlaylistProcessor {
  private static contentProcessor = ContentProcessor.getInstance();

  static process(event: NostrEvent): ProcessedNote {
    const eventId = event.id;
    if (!eventId) throw new Error('Event ID is required');

    const processedContent =
      MusicPlaylistProcessor.contentProcessor.processContentWithTags(
        event.content,
        event.tags
      );

    return {
      id: eventId,
      type: 'music-playlist',
      timestamp: event.created_at,
      author: { pubkey: event.pubkey },
      content: processedContent,
      rawEvent: event,
      musicPlaylist: parseMusicPlaylist(event),
    };
  }
}
