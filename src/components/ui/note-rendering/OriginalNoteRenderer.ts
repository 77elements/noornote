/**
 * OriginalNoteRenderer - Renders original notes (kind:1, kind:6969)
 * Extracts from: NoteUI.createOriginalNoteElement()
 */

import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { NoteStructureBuilder } from './NoteStructureBuilder';
import { CollapsibleManager } from '../note-features/CollapsibleManager';
import { PollRenderer } from '../note-features/PollRenderer';
import { NIP88PollRenderer } from '../note-features/NIP88PollRenderer';
import { QuotedNoteRenderer } from '../../../services/QuotedNoteRenderer';
import { ArticlePreviewRenderer } from '../../../services/ArticlePreviewRenderer';
import { decodeNip19 } from '../../../services/NostrToolsAdapter';

export class OriginalNoteRenderer {

  /**
   * Render original note element
   */
  static render(note: ProcessedNote, opts: NoteUIOptions): HTMLElement {
    // Check if note has quoted references
    const hasQuotedNotes = note.content.quotedReferences.length > 0;

    const { element } = NoteStructureBuilder.build(note, {
      cssClass: 'note-card--original',
      footerLabel: '',
      renderQuotedNotes: hasQuotedNotes
    }, opts);

    // Replace quote markers with actual quote boxes (inline at original position)
    if (hasQuotedNotes) {
      const quotedNoteRenderer = QuotedNoteRenderer.getInstance();
      const articleRenderer = ArticlePreviewRenderer.getInstance();

      note.content.quotedReferences.forEach(ref => {
          const marker = element.querySelector(`.quote-marker[data-quote-ref="${ref.fullMatch}"]`);
          if (marker) {
            // Route naddr references
            if (ref.type === 'addr') {
              // Kind 30402 listings → listing preview via QuotedNoteRenderer
              try {
                const decoded = decodeNip19(ref.fullMatch.replace(/^nostr:/, ''));
                if (decoded.type === 'naddr' && decoded.data?.kind === 30402) {
                  const container = document.createElement('div');
                  marker.replaceWith(container);
                  quotedNoteRenderer.renderListingPreview(ref.fullMatch, container);
                  return;
                }
              } catch { /* fall through */ }
              articleRenderer.renderArticlePreview(ref.fullMatch, marker.parentElement!);
              marker.remove();
            } else {
              // Regular note quote handling
              const skeleton = quotedNoteRenderer.createQuoteSkeleton();
              marker.replaceWith(skeleton);
              quotedNoteRenderer.fetchAndRenderQuote(ref, skeleton, opts.collapsible || false);
            }
          }
      });
    }

    // Check if this is a Poll (kind 6969) and render poll options
    if (note.rawEvent.kind === 6969) {
      PollRenderer.render(element, note.rawEvent);
    }

    // Check if this is a NIP-88 Poll (kind 1068) and render poll options (async)
    // For reposts, the poll data is on the reposted event
    const effectiveEvent = note.repostedEvent || note.rawEvent;
    if (effectiveEvent.kind === 1068 && note.pollData) {
      NIP88PollRenderer.render(element, note.pollData, effectiveEvent).catch(error => {
        console.error('Failed to render NIP-88 poll:', error);
      });
    }

    // Setup collapsible for long notes (only for top-level notes with collapsible enabled)
    if (opts.depth === 0 && opts.collapsible) {
      CollapsibleManager.setup(element, { maxHeight: '40vh' });
    }

    return element;
  }
}
