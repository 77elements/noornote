/**
 * NoteRendererFactory - Factory pattern for note rendering
 * Routes ProcessedNote to specialized renderers
 * Extracts from: NoteUI.createNoteElement() switch statement
 */

import type { ProcessedNote } from '../types/NoteTypes';
import type { NoteUIOptions } from '../types/NoteTypes';
import { OriginalNoteRenderer } from './OriginalNoteRenderer';
import { RepostRenderer } from './RepostRenderer';
import { QuoteRenderer } from './QuoteRenderer';
import { ZapReceiptRenderer } from './ZapReceiptRenderer';
import { UnsupportedKindRenderer } from './UnsupportedKindRenderer';
import { FollowPackRenderer } from './FollowPackRenderer';

export class NoteRendererFactory {
  /**
   * Render ProcessedNote to HTMLElement
   * Routes to specialized renderer based on note type
   */
  static render(note: ProcessedNote, options: NoteUIOptions): HTMLElement {
    switch (note.type) {
      case 'repost':
        return RepostRenderer.render(note, options);
      case 'quote':
        return QuoteRenderer.render(note, options);
      case 'zap-receipt':
        return ZapReceiptRenderer.render(note, options);
      case 'unsupported':
        return UnsupportedKindRenderer.render(note, options);
      case 'follow-pack':
        return FollowPackRenderer.render(note, options);
      default:
        return OriginalNoteRenderer.render(note, options);
    }
  }
}
