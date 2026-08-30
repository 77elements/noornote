/**
 * PodcastEpisodeRenderer — Renders kind 30054 podcast episodes.
 *
 * The body markup (cover, title, duration, audio player, shownotes) is
 * produced by PodcastEpisodeProcessor; this renderer wires the shared note
 * shell (header + ISL + click-to-SNV) via NoteStructureBuilder.
 */

import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { NoteStructureBuilder } from './NoteStructureBuilder';

export class PodcastEpisodeRenderer {
  static render(note: ProcessedNote, opts: NoteUIOptions): HTMLElement {
    const { element } = NoteStructureBuilder.build(
      note,
      {
        cssClass: 'note-card--podcast-episode',
        footerLabel: '',
        renderQuotedNotes: false,
      },
      opts
    );
    return element;
  }
}
