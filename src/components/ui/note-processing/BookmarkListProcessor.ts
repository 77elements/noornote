/**
 * BookmarkListProcessor — NIP-51 categorized bookmark list (kind 30003).
 *
 * NoorNote uses this kind natively for its own bookmark folders
 * (`src/lists/bookmarks.ts`); third-party clients reuse it for media
 * collections — ZapTrax publishes playlists as `d=playlist-*` sets with
 * `r`-tag audio URLs and `track-*` companion tags. The card renders the
 * list metadata (title, item count, tracks with an inline player for
 * playable `r` URLs); the bookmark DATA itself is never rendered (private
 * tags stay encrypted, `e`/`a` references are not resolved here).
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';
import { buildProcessedNote } from './processedNoteFactory';

export class BookmarkListProcessor {
  static process(event: NostrEvent): ProcessedNote {
    return buildProcessedNote(event, {
      type: 'bookmark-list',
      content: {
        text: '',
        html: '',
        media: [],
        links: [],
        hashtags: [],
        quotedReferences: [],
        bolt11Invoices: [],
      },
    });
  }
}
