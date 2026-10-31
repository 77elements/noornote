/**
 * SnoRenderer — Renders SNO "Simple Nostr Objects" (kind 33331, DECK-0003).
 *
 * The processor emits the viewer block (stage placeholder + meta) into the
 * note HTML; this renderer mounts the Canvas-2D viewer into the stage and
 * registers its teardown with the card's lifecycle (NoteStructureBuilder
 * cleanup). The canvas is interactive everywhere — feed card, quote preview
 * and SNV share one code path; `touch-action: pan-y` keeps vertical page
 * scrolling native on touch devices.
 */

import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { NoteStructureBuilder } from './NoteStructureBuilder';
import { SnoCanvasRenderer } from '../../../helpers/sno/snoRenderer';

export class SnoRenderer {
  static render(note: ProcessedNote, opts: NoteUIOptions): HTMLElement {
    const { element } = NoteStructureBuilder.build(
      note,
      {
        cssClass: 'note-card--sno',
        footerLabel: '',
        renderQuotedNotes: false,
      },
      opts
    );

    const snoObject = note.snoData?.object;
    const stage = element.querySelector<HTMLElement>('[data-sno-stage]');
    if (!snoObject || !stage) return element;

    const canvas = document.createElement('canvas');
    stage.appendChild(canvas);

    const viewer = SnoCanvasRenderer.createInteractive(snoObject, canvas);
    viewer.fit(stage);

    // Keep the backing store in sync with the stage's CSS box (mount, window
    // resize, column changes); disconnected when the card subtree is removed.
    const observer = new ResizeObserver(() => viewer.fit(stage));
    observer.observe(stage);
    NoteStructureBuilder.registerDetacher(element, () => {
      observer.disconnect();
      viewer.destroy();
    });

    return element;
  }
}
