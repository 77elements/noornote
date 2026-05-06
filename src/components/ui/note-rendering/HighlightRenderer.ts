/**
 * HighlightRenderer — Renders NIP-84 Highlight events (kind 9802).
 *
 * The body markup is produced by HighlightProcessor; this renderer wires the
 * shared note shell (header + ISL + click-to-SNV) via NoteStructureBuilder.
 */

import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { NoteStructureBuilder } from './NoteStructureBuilder';
import { LongFormOrchestrator } from '../../../services/orchestration/LongFormOrchestrator';
import { getTag } from '../../../helpers/tagUtils';

export class HighlightRenderer {
  static render(note: ProcessedNote, opts: NoteUIOptions): HTMLElement {
    const { element } = NoteStructureBuilder.build(note, {
      cssClass: 'note-card--highlight',
      footerLabel: '',
      renderQuotedNotes: false
    }, opts);

    HighlightRenderer.upgradeArticleSourceLabel(element);

    return element;
  }

  /**
   * Async-replace the placeholder "article" label in the source attribution
   * with the actual article title once we've resolved the addressable event.
   * Falls back silently to "article" if the fetch fails.
   */
  private static upgradeArticleSourceLabel(root: HTMLElement): void {
    const link = root.querySelector('a.highlight__source-link[href^="/article/"]') as HTMLAnchorElement | null;
    if (!link) return;

    const naddr = link.getAttribute('href')?.replace('/article/', '');
    if (!naddr) return;

    LongFormOrchestrator.getInstance()
      .fetchAddressableEvent(naddr)
      .then(article => {
        if (!article) return;
        const title = getTag(article.tags, 'title');
        if (title) link.textContent = title;
      })
      .catch(() => { /* leave "article" fallback */ });
  }
}
