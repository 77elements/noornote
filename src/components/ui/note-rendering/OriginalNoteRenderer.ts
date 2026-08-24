/**
 * OriginalNoteRenderer - Renders original notes (kind:1, kind:6969)
 * Extracts from: NoteUI.createOriginalNoteElement()
 */

import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { NoteStructureBuilder } from './NoteStructureBuilder';
import { CollapsibleManager } from '../note-features/CollapsibleManager';
import { PollRenderer } from '../note-features/PollRenderer';
import { NIP88PollRenderer } from '../note-features/NIP88PollRenderer';
import { QuotedNoteRenderer } from './QuotedNoteRenderer';
import { renderPodcastCard } from './PodcastCard';
import { renderWebCommentCard } from './WebCommentCard';

export class OriginalNoteRenderer {
  /**
   * Render original note element
   */
  static render(note: ProcessedNote, opts: NoteUIOptions): HTMLElement {
    // Check if note has quoted references
    const hasQuotedNotes = note.content.quotedReferences.length > 0;

    const { element } = NoteStructureBuilder.build(
      note,
      {
        cssClass: 'note-card--original',
        footerLabel: '',
        renderQuotedNotes: hasQuotedNotes,
      },
      opts
    );

    // Replace quote markers with actual quote boxes (inline at original position)
    if (hasQuotedNotes) {
      const quotedNoteRenderer = QuotedNoteRenderer.getInstance();

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
            quotedNoteRenderer.renderAddressableReference(
              ref.fullMatch,
              container,
              ref.fragment
            );
          } else {
            // Regular note quote handling. Parent author = the note that
            // CONTAINS this quote — passed through so QuoteOrchestrator can
            // fall back to the quoter's outbound relays when the quoted
            // event's own author relays don't carry the original.
            const skeleton = quotedNoteRenderer.createQuoteSkeleton();
            marker.replaceWith(skeleton);
            // Always false: the outer note's collapsible (set up below) handles
            // truncation for the entire content including nested quotes. Letting
            // the inner quote add its own Show More would stack two buttons.
            void quotedNoteRenderer.fetchAndRenderQuote(
              ref,
              skeleton,
              false,
              note.author?.pubkey
            );
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
      NIP88PollRenderer.render(element, note.pollData, effectiveEvent).catch(
        error => {
          console.error('Failed to render NIP-88 poll:', error);
        }
      );
    }

    // NIP-73 podcast reference (e.g. Fountain boosts) → inline podcast card,
    // appended to the note body. For reposts the tags live on the inner event.
    const podcastSource = note.repostedEvent || note.rawEvent;
    const podcastCard = renderPodcastCard(podcastSource);
    if (podcastCard) {
      (element.querySelector('.event-content') || element).appendChild(
        podcastCard
      );
    }

    // Web comment (NIP-22 comment whose root is a web page, NIP-73 `k:web`) → inline
    // "Commenting on <site>" card. Core: the client reads these like any other note.
    const webSource = note.repostedEvent || note.rawEvent;
    const webCard = renderWebCommentCard(webSource);
    if (webCard) {
      (element.querySelector('.event-content') || element).appendChild(webCard);
    }

    // Setup collapsible for long notes (only for top-level notes with collapsible enabled)
    if (opts.depth === 0 && opts.collapsible) {
      CollapsibleManager.setup(element, { maxHeight: '40vh' });
    }

    return element;
  }
}
