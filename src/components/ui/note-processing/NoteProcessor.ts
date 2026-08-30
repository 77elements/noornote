/**
 * NoteProcessor - Main processor for all note types
 * Routes events to specialized processors based on kind
 * Extracts from: NoteUI.processNote()
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';
import { TextNoteProcessor } from './TextNoteProcessor';
import { RepostProcessor } from './RepostProcessor';
import { PollProcessor } from './PollProcessor';
import { ArticleProcessor } from './ArticleProcessor';
import { ZapReceiptProcessor } from './ZapReceiptProcessor';
import { VideoNoteProcessor } from './VideoNoteProcessor';
import { PictureNoteProcessor } from './PictureNoteProcessor';
import { FileMetadataProcessor } from './FileMetadataProcessor';
import { FollowPackProcessor } from './FollowPackProcessor';
import { EmojiPackProcessor } from './EmojiPackProcessor';
import { GitEventProcessor } from './GitEventProcessor';
import { HighlightProcessor } from './HighlightProcessor';
import { BadgeAwardProcessor } from './BadgeAwardProcessor';
import { LiveStreamProcessor } from './LiveStreamProcessor';
import { ListingProcessor } from './ListingProcessor';
import { PodcastEpisodeProcessor } from './PodcastEpisodeProcessor';

export class NoteProcessor {
  /**
   * Process any Nostr event into a ProcessedNote
   * SYNCHRONOUS - routes to specialized processor
   */
  static process(event: NostrEvent): ProcessedNote {
    const eventId = event.id ?? 'unknown';
    try {
      switch (event.kind) {
        case 1:
        case 1111:
          return TextNoteProcessor.process(event);
        case 6:
        case 16:
          return RepostProcessor.process(event);
        case 8:
          return BadgeAwardProcessor.process(event);
        case 20:
          return PictureNoteProcessor.process(event);
        case 21:
        case 22:
          return VideoNoteProcessor.process(event);
        case 1063:
          return FileMetadataProcessor.process(event);
        case 1068:
          return PollProcessor.process(event);
        case 9735:
          return ZapReceiptProcessor.process(event);
        case 9802:
          return HighlightProcessor.process(event);
        case 30023:
          return ArticleProcessor.process(event);
        case 30054:
          return PodcastEpisodeProcessor.process(event);
        case 30402:
          return ListingProcessor.process(event);
        case 30311:
          return LiveStreamProcessor.process(event);
        case 39089:
          return FollowPackProcessor.process(event);
        case 30030:
          return EmojiPackProcessor.process(event);
        case 1617:
        case 1618:
        case 1619:
        case 1621:
        case 1630:
        case 1631:
        case 1632:
        case 1633:
        case 30617:
          return GitEventProcessor.process(event);
        default:
          return NoteProcessor.createUnsupportedNote(event, eventId);
      }
    } catch (error) {
      console.error(`❌ ERROR processing note ${eventId.slice(0, 8)}:`, error);
      return NoteProcessor.createUnsupportedNote(event, eventId);
    }
  }

  /**
   * Create unsupported note for unknown event kinds
   */
  private static createUnsupportedNote(
    event: NostrEvent,
    eventId: string
  ): ProcessedNote {
    return {
      id: eventId,
      type: 'unsupported',
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
