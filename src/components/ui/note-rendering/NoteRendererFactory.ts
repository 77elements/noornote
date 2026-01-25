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
      default:
        return OriginalNoteRenderer.render(note, options);
    }
  }
}
