/**
 * CurationSetRenderer - Renders an NIP-51 article curation set (kind 30004)
 * as a light nn-card in TV/PV/quotes/reposts. Card: cover image, title,
 * description, item count and — when the content carries one — an external
 * link (e.g. the zap.cooking pack page). Click opens the SNV (naddr), where
 * CurationSetItems additionally lists the referenced items. Deliberately
 * does NOT fetch the referenced items here (see CurationSetItems).
 */

import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { NoteHeader } from '../NoteHeader';
import {
  parseCurationSetEvent,
  CURATION_SET_KIND,
} from '../../../helpers/parseCurationSet';
import { getAddressableIdentifier } from '../../../helpers/getAddressableIdentifier';
import { encodeNaddr } from '../../../services/NostrToolsAdapter';
import { getViewNavigationController } from '../../../services/ViewNavigationController';
import { escapeHtml, escapeHtmlAttr } from '../../../helpers/escapeHtml';
import { appendPackISL } from './packCardShared';

export class CurationSetRenderer {
  static render(note: ProcessedNote, _opts: NoteUIOptions): HTMLElement {
    const event = note.rawEvent;
    const set = parseCurationSetEvent(event);

    const element = document.createElement('div');
    element.className = 'note-card note-card--curation-set';
    element.dataset.eventId = note.id;

    const naddr = encodeNaddr({
      kind: CURATION_SET_KIND,
      pubkey: event.pubkey,
      identifier: set.id,
      relays: [],
    });

    const noteHeader = new NoteHeader({
      pubkey: event.pubkey,
      eventId: note.id,
      timestamp: note.timestamp,
      rawEvent: event,
      showVerification: true,
      showTimestamp: true,
      showMenu: true,
    });
    element.appendChild(noteHeader.getElement());

    const card = document.createElement('div');
    card.className = 'nn-card';
    const coverClass = set.coverImage
      ? 'nn-card__media'
      : 'nn-card__media nn-card__media--empty';
    const externalLabel = this.externalLinkLabel(set.externalUrl);
    card.innerHTML = `
      <div class="${coverClass}">
        ${set.coverImage ? `<img src="${escapeHtmlAttr(set.coverImage)}" alt="" loading="lazy" />` : ''}
      </div>
      <div class="nn-card__content">
        <h3>${escapeHtml(set.title)}</h3>
        ${set.description ? `<p class="nn-card__meta">${escapeHtml(set.description)}</p>` : ''}
        <div class="meta">${set.itemRefs.length} items</div>
        ${
          externalLabel
            ? `
        <div class="l-row--right">
          <a class="btn btn--passive btn--mini" href="${escapeHtmlAttr(set.externalUrl)}" target="_blank" rel="noopener noreferrer" data-action="external-link">${escapeHtml(externalLabel)}</a>
        </div>
        `
            : ''
        }
      </div>
    `;

    // Route through the central controller so the SNV (with the item list)
    // opens in the right pane in right-pane mode. Links/buttons never navigate.
    card.addEventListener('click', e => {
      const target = e.target as HTMLElement;
      if (target.closest('.note-image--clickable, .note-media, video')) return;
      if (target.closest('button') || target.closest('a')) return;
      getViewNavigationController().openView('single-note', naddr, e);
    });

    element.appendChild(card);

    const addressableId = getAddressableIdentifier(event);
    const noteId = addressableId || event.id;
    if (noteId) appendPackISL(element, event, noteId, _opts);

    return element;
  }

  /** Hostname-based label for the external link ('' when there is none). */
  private static externalLinkLabel(url: string): string {
    if (!url) return '';
    try {
      return `${new URL(url).hostname} ↗`;
    } catch {
      return url;
    }
  }
}
