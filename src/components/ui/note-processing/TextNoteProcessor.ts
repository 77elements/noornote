/**
 * TextNoteProcessor - Process kind:1 text notes
 * Extracts from: NoteUI.processTextNote()
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';
import { ContentProcessor } from '../../../services/ContentProcessor';

export class TextNoteProcessor {
  private static contentProcessor = ContentProcessor.getInstance();

  /**
   * Process kind:1 text note
   * SYNCHRONOUS - no blocking calls
   */
  static process(event: NostrEvent): ProcessedNote {
    const eventId = event.id;
    if (!eventId) {
      throw new Error('Event ID is required');
    }

    const authorProfile = TextNoteProcessor.contentProcessor.getNonBlockingProfile(event.pubkey);
    const quoteTags = event.tags.filter(tag => tag[0] === 'q');
    const isQuote = quoteTags.length > 0;

    const processedContent = TextNoteProcessor.contentProcessor.processContentWithTags(
      event.content,
      event.tags
    );

    const result: ProcessedNote = {
      id: eventId,
      type: isQuote ? 'quote' : 'original',
      timestamp: event.created_at,
      author: {
        pubkey: event.pubkey
      },
      content: processedContent,
      rawEvent: event
    };

    if (authorProfile) {
      result.author.profile = {
        name: authorProfile.name,
        display_name: authorProfile.display_name,
        picture: authorProfile.picture
      };
    }

    return result;
  }
}
