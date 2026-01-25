/**
 * UnsupportedKindRenderer - Renders fallback for unknown event kinds
 * Shows "Unsupported event kind X" with "Open in another client" button
 */

import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { encodeNevent } from '../../../services/NostrToolsAdapter';

export class UnsupportedKindRenderer {
  /**
   * Render unsupported kind fallback element
   */
  static render(note: ProcessedNote, _opts: NoteUIOptions): HTMLElement {
    const element = document.createElement('div');
    element.className = 'note-card note-card--unsupported';
    if (note.id) element.dataset.eventId = note.id;

    const kind = note.rawEvent.kind;
    const nevent = note.id ? encodeNevent(note.id) : '';
    const njumpUrl = nevent ? `https://njump.me/${nevent}` : '';

    element.innerHTML = `
      <div class="unsupported-kind">
        <div class="unsupported-kind__message">
          Unsupported event kind ${kind}
        </div>
        ${njumpUrl ? `
          <a href="${njumpUrl}" target="_blank" rel="noopener noreferrer" class="btn">
            ↗ Open in another client
          </a>
        ` : ''}
      </div>
    `;

    return element;
  }
}
