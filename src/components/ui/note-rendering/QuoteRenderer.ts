/**
 * QuoteRenderer - Renders quote notes (kind:1 with quote tags)
 * Extracts from: NoteUI.createQuoteElement()
 */

import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { NoteStructureBuilder } from './NoteStructureBuilder';
import { QuotedNoteRenderer } from '../../../services/QuotedNoteRenderer';
import { ArticlePreviewRenderer } from '../../../services/ArticlePreviewRenderer';
import { decodeNip19 } from '../../../services/NostrToolsAdapter';
import { CollapsibleManager } from '../note-features/CollapsibleManager';

export class QuoteRenderer {
  private static quotedNoteRenderer = QuotedNoteRenderer.getInstance();
  private static articleRenderer = ArticlePreviewRenderer.getInstance();

  /**
   * Create quote element with embedded quoted notes (NON-BLOCKING)
   * Returns immediately, quotes load in background
   */
  static render(note: ProcessedNote, opts: NoteUIOptions): HTMLElement {
    const { element } = NoteStructureBuilder.build(note, {
      cssClass: 'note-card--quote',
      footerLabel: 'Quote',
      renderQuotedNotes: true
    }, opts);

    // Replace quote markers with actual quote boxes (inline at original position)
    if (note.content.quotedReferences.length > 0) {
      note.content.quotedReferences.forEach(ref => {
        const marker = element.querySelector(`.quote-marker[data-quote-ref="${ref.fullMatch}"]`);
        if (marker) {
          // Route naddr references
          if (ref.type === 'addr') {
            try {
              const decoded = decodeNip19(ref.fullMatch.replace(/^nostr:/, ''));
              if (decoded.type === 'naddr' && decoded.data?.kind === 30402) {
                const container = document.createElement('div');
                marker.replaceWith(container);
                QuoteRenderer.quotedNoteRenderer.renderListingPreview(ref.fullMatch, container);
                return;
              }
            } catch { /* fall through */ }
            QuoteRenderer.articleRenderer.renderArticlePreview(ref.fullMatch, marker.parentElement!);
            marker.remove();
          } else {
            // Regular note quote handling
            const skeleton = QuoteRenderer.quotedNoteRenderer.createQuoteSkeleton();
            marker.replaceWith(skeleton);
            QuoteRenderer.quotedNoteRenderer.fetchAndRenderQuote(ref, skeleton, opts.collapsible || false);
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
