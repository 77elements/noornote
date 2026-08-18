/**
 * ListingRenderer - Renders a NIP-99 classified listing (kind 30402) as a
 * timeline-listing-card in TV/PV/SNV and inside reposts.
 * Card: cover image, title + price + summary, "Marketplace" badge, ISL.
 * Detail view (gallery, buy, edit) lives in the marketplace addon's ListingView.
 */

import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { NoteHeader } from '../NoteHeader';
import { InteractionStatusLine } from '../InteractionStatusLine';
import { parseListingMetadata, formatPrice } from '../../../helpers/listingMetadata';
import { getAddressableIdentifier } from '../../../helpers/getAddressableIdentifier';
import { encodeNaddr } from '../../../services/NostrToolsAdapter';
import { getViewNavigationController } from '../../../services/ViewNavigationController';
import { escapeHtml, escapeHtmlAttr } from '../../../helpers/escapeHtml';

export class ListingRenderer {
  static render(note: ProcessedNote, opts: NoteUIOptions): HTMLElement {
    const event = note.rawEvent;
    const meta = parseListingMetadata(event);
    const priceDisplay = formatPrice(meta.price, meta.priceCurrency, meta.priceFrequency);
    const firstImage = meta.images[0] || '';

    const element = document.createElement('div');
    element.className = 'note-card note-card--listing';
    element.dataset.eventId = note.id;

    const noteHeader = new NoteHeader({
      pubkey: event.pubkey,
      eventId: note.id,
      timestamp: note.timestamp,
      rawEvent: event,
      showVerification: true,
      showTimestamp: true,
      showMenu: true
    });
    element.appendChild(noteHeader.getElement());

    const card = document.createElement('div');
    card.className = 'timeline-listing-card';
    card.style.cursor = 'pointer';
    card.innerHTML = `
      ${firstImage ? `
        <div class="timeline-listing-card__image">
          <img src="${escapeHtmlAttr(firstImage)}" alt="" loading="lazy" />
        </div>
      ` : ''}
      <div class="timeline-listing-card__body">
        <div class="timeline-listing-card__seller">
          <span class="timeline-listing-card__badge">Marketplace</span>
          ${meta.location ? `<span class="timeline-listing-card__location">${escapeHtml(meta.location)}</span>` : ''}
        </div>
        <h3 class="timeline-listing-card__title">${escapeHtml(meta.title)}</h3>
        <div class="timeline-listing-card__price">${escapeHtml(priceDisplay)}</div>
        ${meta.summary ? `<p class="timeline-listing-card__summary">${escapeHtml(meta.summary.slice(0, 120))}${meta.summary.length > 120 ? '...' : ''}</p>` : ''}
      </div>
    `;

    const naddr = encodeNaddr({
      kind: 30402,
      pubkey: event.pubkey,
      identifier: meta.identifier,
      relays: []
    });

    card.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      // Inviolable media-click rule: never pre-empt image/video handlers.
      if (target.closest('.note-image--clickable, .note-media, video')) return;
      if (target.closest('button') || target.closest('a')) return;
      e.stopPropagation();
      // Route through the central controller so right-pane mode opens the
      // listing in the secondary pane (scc) instead of the timeline (pcc).
      getViewNavigationController().openView('listing', naddr, e);
    });

    element.appendChild(card);

    // ISL needs the addressable coordinate for addressable events (kind 30000+)
    const addressableId = getAddressableIdentifier(event);
    const noteId = addressableId || event.id;
    if (noteId) {
      const isl = new InteractionStatusLine({
        noteId,
        authorPubkey: event.pubkey,
        originalEvent: event,
        fetchStats: opts.islFetchStats || false,
        isLoggedIn: opts.isLoggedIn || false,
        ...(event.id ? { articleEventId: event.id } : {}),
      });
      element.appendChild(isl.getElement());
    }

    return element;
  }
}
