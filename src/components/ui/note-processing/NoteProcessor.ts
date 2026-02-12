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
          return TextNoteProcessor.process(event);
        case 6:
          return RepostProcessor.process(event);
        case 21:
        case 22:
          return VideoNoteProcessor.process(event);
        case 1068:
          return PollProcessor.process(event);
        case 9735:
          return ZapReceiptProcessor.process(event);
        case 30023:
          return ArticleProcessor.process(event);
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
  private static createUnsupportedNote(event: NostrEvent, eventId: string): ProcessedNote {
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
        quotedReferences: []
      },
      rawEvent: event
    };
  }
}
