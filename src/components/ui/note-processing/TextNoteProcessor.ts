/**
 * TextNoteProcessor - Process kind:1 text notes
 * Extracts from: NoteUI.processTextNote()
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';
import {
  isGatedNoteEvent,
  stripGatedNoteCta,
} from '../../../helpers/gatedNote';
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

    const authorProfile =
      TextNoteProcessor.contentProcessor.getNonBlockingProfile(event.pubkey);
    const quoteTags = event.tags.filter(tag => tag[0] === 'q');
    const isQuote = quoteTags.length > 0;

    // Gated premium notes (fanfares): the public content is a teaser ending
    // in a SELF-REFERENTIAL unlock CTA — rendering its quote references
    // recurses forever. Strip the CTA and render plain text (no markers).
    const isGated = isGatedNoteEvent(event);
    const processedContent = isGated
      ? TextNoteProcessor.contentProcessor.processContent(
          stripGatedNoteCta(event.content)
        )
      : TextNoteProcessor.contentProcessor.processContentWithTags(
          event.content,
          event.tags
        );

    const result: ProcessedNote = {
      id: eventId,
      type: isGated ? 'premium' : isQuote ? 'quote' : 'original',
      timestamp: event.created_at,
      author: {
        pubkey: event.pubkey,
      },
      content: processedContent,
      rawEvent: event,
    };

    if (authorProfile) {
      result.author.profile = {
        ...(authorProfile.name !== undefined && { name: authorProfile.name }),

        ...(authorProfile.display_name !== undefined && {
          display_name: authorProfile.display_name,
        }),

        ...(authorProfile.picture !== undefined && {
          picture: authorProfile.picture,
        }),
      };
    }

    return result;
  }
}
