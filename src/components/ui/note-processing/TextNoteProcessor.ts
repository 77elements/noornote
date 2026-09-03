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
import { buildProcessedNote } from './processedNoteFactory';

export class TextNoteProcessor {
  private static contentProcessor = ContentProcessor.getInstance();

  /**
   * Process kind:1 text note
   * SYNCHRONOUS - no blocking calls
   */
  static process(event: NostrEvent): ProcessedNote {
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

    return buildProcessedNote(event, {
      type: isGated ? 'premium' : isQuote ? 'quote' : 'original',
      content: processedContent,
    });
  }
}
