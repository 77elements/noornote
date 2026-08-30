/**
 * NoteRendererFactory - Factory pattern for note rendering
 * Routes ProcessedNote to specialized renderers
 * Extracts from: NoteUI.createNoteElement() switch statement
 */

import { type ProcessedNote, type NoteUIOptions } from '../types/NoteTypes';
import { OriginalNoteRenderer } from './OriginalNoteRenderer';
import { RepostRenderer } from './RepostRenderer';
import { QuoteRenderer } from './QuoteRenderer';
import { ZapReceiptRenderer } from './ZapReceiptRenderer';
import { UnsupportedKindRenderer } from './UnsupportedKindRenderer';
import { FollowPackRenderer } from './FollowPackRenderer';
import { GitEventRenderer } from './GitEventRenderer';
import { HighlightRenderer } from './HighlightRenderer';
import { PodcastEpisodeRenderer } from './PodcastEpisodeRenderer';
import { BadgeAwardRenderer } from './BadgeAwardRenderer';
import { EmojiPackRenderer } from './EmojiPackRenderer';
import { LiveStreamRenderer } from './LiveStreamRenderer';
import { ListingRenderer } from './ListingRenderer';

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
      case 'git-event':
        return GitEventRenderer.render(note, options);
      case 'highlight':
        return HighlightRenderer.render(note, options);
      case 'podcast-episode':
        return PodcastEpisodeRenderer.render(note, options);
      case 'badge-award':
        return BadgeAwardRenderer.render(note, options);
      case 'emoji-pack':
        return EmojiPackRenderer.render(note, options);
      case 'live-stream':
        return LiveStreamRenderer.render(note, options);
      case 'listing':
        return ListingRenderer.render(note, options);
      default:
        return OriginalNoteRenderer.render(note, options);
    }
  }
}
