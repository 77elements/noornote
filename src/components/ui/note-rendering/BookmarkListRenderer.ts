/**
 * BookmarkListRenderer — renders an NIP-51 categorized bookmark list
 * (kind 30003) as an nn-card in quotes/reposts/SNV. NoorNote's own bookmark
 * folders share this kind; third-party clients (ZapTrax) publish playlists
 * with `track-*` companion tags. Card: cover (first track image), title,
 * item count, and — when track metadata is present — a track list with a
 * shared native audio player: clicking a track row assigns its `r`-tag URL
 * to the player and starts playback. Plain bookmark lists render as a
 * summary card (title + count) only; `e`/`a` references are never resolved
 * here. Click opens the SNV (naddr).
 */

import { _ } from '../../../i18n';
import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { NoteHeader } from '../NoteHeader';
import {
  parseBookmarkSetEvent,
  isPlayableUrl,
  BOOKMARK_SET_KIND,
} from '../../../helpers/parseBookmarkList';
import { getAddressableIdentifier } from '../../../helpers/getAddressableIdentifier';
import { encodeNaddr } from '../../../services/NostrToolsAdapter';
import { getViewNavigationController } from '../../../services/ViewNavigationController';
import { escapeHtml, escapeHtmlAttr } from '../../../helpers/escapeHtml';
import { appendPackISL } from './packCardShared';
import { buildMusicPlayerHtml, wireMusicPlayer } from './musicPlayerShared';

export class BookmarkListRenderer {
  static render(note: ProcessedNote, _opts: NoteUIOptions): HTMLElement {
    const event = note.rawEvent;
    const list = parseBookmarkSetEvent(event);

    const element = document.createElement('div');
    element.className = 'note-card note-card--bookmark-list';
    element.dataset.eventId = note.id;

    const naddr = encodeNaddr({
      kind: BOOKMARK_SET_KIND,
      pubkey: event.pubkey,
      identifier: list.id,
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

    const coverImage = isPlayableUrl(list.tracks.find(t => t.image)?.image)
      ? (list.tracks.find(t => t.image)?.image ?? '')
      : '';
    const countLabel = list.isPlaylist
      ? `${list.itemCount} tracks`
      : `${list.itemCount} items`;

    const card = document.createElement('div');
    card.className = 'nn-card bookmark-list';
    card.innerHTML = `
      <div class="${coverImage ? 'nn-card__media' : 'nn-card__media nn-card__media--empty'}">
        ${coverImage ? `<img src="${escapeHtmlAttr(coverImage)}" alt="" loading="lazy" />` : ''}
      </div>
      <div class="nn-card__content">
        <h3>${escapeHtml(list.title)}</h3>
        <div class="meta">${escapeHtml(list.isPlaylist ? _('Playlist') : _('Bookmark list'))} · ${escapeHtml(countLabel)}</div>
        ${list.isPlaylist ? BookmarkListRenderer.buildPlayerHtml(list) : ''}
      </div>
    `;

    if (list.isPlaylist) {
      wireMusicPlayer(card);
    }

    // Route through the central controller so the SNV opens in the right
    // pane in right-pane mode. Links/buttons/player controls never navigate.
    card.addEventListener('click', e => {
      const target = e.target as HTMLElement;
      if (
        target.closest('.note-image--clickable, .note-media, video, audio') ||
        target.closest('button') ||
        target.closest('a')
      ) {
        return;
      }
      getViewNavigationController().openView('single-note', naddr, e);
    });

    element.appendChild(card);

    const addressableId = getAddressableIdentifier(event);
    const noteId = addressableId || event.id;
    if (noteId) appendPackISL(element, event, noteId, _opts);

    return element;
  }

  /** Player + track rows via the shared music player (kind-30003 variant). */
  private static buildPlayerHtml(
    list: ReturnType<typeof parseBookmarkSetEvent>
  ): string {
    return buildMusicPlayerHtml(
      list.tracks.map((track, index) => ({
        ref: track.ref,
        title: track.title,
        artist: track.artist,
        durationSec: track.durationSec,
        indexLabel: String(index + 1),
      }))
    );
  }
}
