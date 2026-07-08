/**
 * UnsupportedKindRenderer - Renders fallback for unknown event kinds
 * Shows "Unsupported event kind X" with "Open in another client" button
 */

import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { encodeNevent, encodeNaddr } from '../../../services/NostrToolsAdapter';
import { DittoFeatureRenderer, DITTO_GEOCACHE_KIND } from './DittoFeatureRenderer';

export class UnsupportedKindRenderer {
  /**
   * Render unsupported kind fallback element
   */
  static render(note: ProcessedNote, _opts: NoteUIOptions): HTMLElement {
    // Ditto geocache (kind 37516): show a dedicated "open in Ditto" notice
    // instead of a generic "unsupported kind" + njump link.
    if (note.rawEvent.kind === DITTO_GEOCACHE_KIND) {
      return DittoFeatureRenderer.render(note.rawEvent);
    }

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

  /**
   * Render the same fallback straight from a decoded naddr coordinate — used by
   * the addressable-quote routing, which only has the coordinate (no fetched
   * event). Keeps addressable events that aren't a supported kind (e.g. a
   * proprietary community kind) out of the article renderer: same card, "open in
   * another client" points at the naddr on njump. Ditto geocache keeps its own
   * dedicated notice.
   */
  static renderFromCoordinate(kind: number, pubkey: string, identifier: string): HTMLElement {
    if (kind === DITTO_GEOCACHE_KIND) {
      return DittoFeatureRenderer.renderFromCoordinate(kind, pubkey, identifier);
    }

    const element = document.createElement('div');
    element.className = 'note-card note-card--unsupported';

    const naddr = encodeNaddr({ kind, pubkey, identifier, relays: [] });
    const njumpUrl = `https://njump.me/${naddr}`;

    element.innerHTML = `
      <div class="unsupported-kind">
        <div class="unsupported-kind__message">
          Unsupported event kind ${kind}
        </div>
        <a href="${njumpUrl}" target="_blank" rel="noopener noreferrer" class="btn">
          ↗ Open in another client
        </a>
      </div>
    `;

    return element;
  }
}
