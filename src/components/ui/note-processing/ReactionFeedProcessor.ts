/**
 * ReactionFeedProcessor — NIP-25 reaction (kind 7) as a timeline entry.
 *
 * Only reaches the pipeline when the show-reactions setting includes the
 * reactor (see helpers/reactionsFeedSetting.ts + FeedOrchestrator gating).
 * All rendering happens in ReactionFeedRenderer from the raw event (emoji
 * content + target resolution are async); the processor only tags the type.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';
import { buildProcessedNote } from './processedNoteFactory';

export class ReactionFeedProcessor {
  static process(event: NostrEvent): ProcessedNote {
    return buildProcessedNote(event, {
      type: 'reaction',
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
