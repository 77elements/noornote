/**
 * FollowPackRenderer - Renders a Follow Pack (kind 39089) as an nn-card in TV/PV.
 * Card: cover image, title + member count, "Open Follow Pack" button, ISL.
 */

import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { NoteHeader } from '../NoteHeader';
import { InteractionStatusLine } from '../InteractionStatusLine';
import { parseFollowPackEvent } from '../../../helpers/parseFollowPack';
import { getAddressableIdentifier } from '../../../helpers/getAddressableIdentifier';
import { encodeNaddr } from '../../../services/NostrToolsAdapter';
import { Router } from '../../../services/Router';
import { escapeHtml, escapeHtmlAttr } from '../../../helpers/escapeHtml';

export class FollowPackRenderer {
  static render(note: ProcessedNote, opts: NoteUIOptions): HTMLElement {
    const event = note.rawEvent;
    const pack = parseFollowPackEvent(event);

    const element = document.createElement('div');
    element.className = 'note-card note-card--follow-pack';
    element.dataset.eventId = note.id;

    const naddr = encodeNaddr({
      kind: 39089,
      pubkey: event.pubkey,
      identifier: pack.id,
      relays: []
    });
    const route = `/follow-pack/${naddr}`;

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
    card.className = 'nn-card';
    const coverClass = pack.coverImage ? 'nn-card__media' : 'nn-card__media nn-card__media--empty';
    card.innerHTML = `
      <div class="${coverClass}">
        ${pack.coverImage ? `<img src="${escapeHtmlAttr(pack.coverImage)}" alt="" loading="lazy" />` : ''}
      </div>
      <div class="nn-card__content">
        <h3>${escapeHtml(pack.title)}</h3>
        <div class="meta">${pack.userPubkeys.length} people</div>
        <button class="btn btn--passive btn--mini" type="button" data-action="open-pack">Open Follow Pack</button>
      </div>
    `;

    const openBtn = card.querySelector('[data-action="open-pack"]');
    openBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      Router.getInstance().navigate(route);
    });

    card.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.note-image--clickable, .note-media, video')) return;
      if (target.closest('button') || target.closest('a')) return;
      Router.getInstance().navigate(route);
    });

    element.appendChild(card);

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
