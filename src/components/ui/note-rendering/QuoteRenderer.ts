/**
 * QuoteRenderer - Renders quote notes (kind:1 with quote tags)
 * Extracts from: NoteUI.createQuoteElement()
 */

import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { NoteStructureBuilder } from './NoteStructureBuilder';
import { QuotedNoteRenderer } from './QuotedNoteRenderer';
import { CollapsibleManager } from '../note-features/CollapsibleManager';

export class QuoteRenderer {
  private static quotedNoteRenderer = QuotedNoteRenderer.getInstance();

  /**
   * Create quote element with embedded quoted notes (NON-BLOCKING)
   * Returns immediately, quotes load in background
   */
  static render(note: ProcessedNote, opts: NoteUIOptions): HTMLElement {
    const { element } = NoteStructureBuilder.build(
      note,
      {
        cssClass: 'note-card--quote',
        footerLabel: 'Quote',
        renderQuotedNotes: true,
      },
      opts
    );

    // Replace quote markers with actual quote boxes (inline at original position)
    if (note.content.quotedReferences.length > 0) {
      note.content.quotedReferences.forEach(ref => {
        const marker = element.querySelector(
          `.quote-marker[data-quote-ref="${ref.fullMatch}"]`
        );
        if (marker) {
          // Route naddr references by kind (listing / article / Ditto /
          // unsupported) — never blindly to the article renderer.
          if (ref.type === 'addr') {
            const container = document.createElement('div');
            marker.replaceWith(container);
            QuoteRenderer.quotedNoteRenderer.renderAddressableReference(
              ref.fullMatch,
              container,
              ref.fragment
            );
          } else {
            // Regular note quote handling. Parent author = the quoting note
            // — fed to QuoteOrchestrator's outbound fallback so the quoter's
            // own relays are tried before "Note not found".
            const skeleton =
              QuoteRenderer.quotedNoteRenderer.createQuoteSkeleton();
            marker.replaceWith(skeleton);
            // Always false: the outer note's collapsible (set up below) handles
            // truncation for the entire content including nested quotes.
            QuoteRenderer.quotedNoteRenderer.fetchAndRenderQuote(
              ref,
              skeleton,
              false,
              note.author?.pubkey
            );
          }
        }
      });
    }

    // Setup collapsible for long notes (only for top-level notes with collapsible enabled)
    if (opts.depth === 0 && opts.collapsible) {
      CollapsibleManager.setup(element, { maxHeight: '40vh' });
    }

    return element;
  }
}
