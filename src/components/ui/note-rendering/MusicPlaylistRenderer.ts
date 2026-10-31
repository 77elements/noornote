/**
 * MusicPlaylistRenderer — kind 34139 "Music Playlist" card (podtunes/nostria
 * convention). Renders a summary card (cover, title, track count) immediately
 * and resolves the referenced kind-36787 tracks lazily: each `a`-tag
 * coordinate is fetched through the quote pipeline and appended to its
 * placeholder row slot, so the track list fills in without blocking the
 * render. Playback shares the native audio player from the bookmark-list
 * card (same markup/classes, event-delegated clicks so late rows work).
 */

import { _ } from '../../../i18n';
import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { NoteHeader } from '../NoteHeader';
import { isPlayableUrl } from '../../../helpers/parseBookmarkList';
import {
  MUSIC_PLAYLIST_KIND,
  MUSIC_TRACK_KIND,
  splitTrackRef,
} from '../../../helpers/parseMusicTrack';
import { encodeNaddr } from '../../../services/NostrToolsAdapter';
import { QuoteNoteFetcher } from '../../../services/QuoteNoteFetcher';
import { getViewNavigationController } from '../../../services/ViewNavigationController';
import { escapeHtml, escapeHtmlAttr } from '../../../helpers/escapeHtml';
import { getTag } from '../../../helpers/tagUtils';
import { appendPackISL } from './packCardShared';
import { buildMusicTrackRowHtml, wireMusicPlayer } from './musicPlayerShared';

export class MusicPlaylistRenderer {
  static render(note: ProcessedNote, _opts: NoteUIOptions): HTMLElement {
    const event = note.rawEvent;
    const playlist = note.musicPlaylist;

    const element = document.createElement('div');
    element.className = 'note-card note-card--bookmark-list';
    element.dataset.eventId = note.id;

    const naddr = encodeNaddr({
      kind: MUSIC_PLAYLIST_KIND,
      pubkey: event.pubkey,
      identifier: playlist?.id ?? '',
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

    const refs = playlist?.trackRefs ?? [];
    const coverImage = isPlayableUrl(playlist?.image)
      ? (playlist?.image ?? '')
      : '';

    const card = document.createElement('div');
    card.className = 'nn-card bookmark-list';
    card.innerHTML = `
      <div class="${coverImage ? 'nn-card__media' : 'nn-card__media nn-card__media--empty'}">
        ${coverImage ? `<img src="${escapeHtmlAttr(coverImage)}" alt="" loading="lazy" />` : ''}
      </div>
      <div class="nn-card__content">
        <h3>${escapeHtml(playlist?.title || _('Playlist'))}</h3>
        <div class="meta">${escapeHtml(_('Playlist'))} · ${refs.length} tracks</div>
        ${refs.length > 0 ? MusicPlaylistRenderer.buildSkeletonHtml(refs) : ''}
      </div>
    `;

    if (refs.length > 0) {
      wireMusicPlayer(card);
      void MusicPlaylistRenderer.loadTracks(card, refs);
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

    appendPackISL(element, event, note.id, _opts);
    return element;
  }

  /** One empty placeholder row per reference, filled in fetch order. */
  private static buildSkeletonHtml(refs: string[]): string {
    const rows = refs
      .map(
        (_, i) => `
        <li class="bookmark-list__track" data-slot="${i}">
          <span class="bookmark-list__track-index">${i + 1}</span>
          <span class="bookmark-list__track-title">…</span>
        </li>`
      )
      .join('');
    return `
      <audio class="bookmark-list__player" controls preload="none"></audio>
      <ol class="bookmark-list__tracks">${rows}</ol>
    `;
  }

  /**
   * Resolve every `36787:<pubkey>:<d-tag>` reference through the quote
   * pipeline and fill its placeholder row. Rows keep the playlist's a-tag
   * order; failures leave the placeholder as-is (silent — a missing track
   * must not nuke the whole card).
   */
  private static async loadTracks(
    card: HTMLElement,
    refs: string[]
  ): Promise<void> {
    const fetcher = QuoteNoteFetcher.getInstance();
    await Promise.allSettled(
      refs.map(async (ref, index) => {
        const parts = splitTrackRef(ref);
        if (!parts) return;
        const naddr = encodeNaddr({
          kind: MUSIC_TRACK_KIND,
          pubkey: parts.pubkey,
          identifier: parts.identifier,
          relays: [],
        });
        const result = await fetcher.fetchQuotedEventWithError(naddr);
        if (!result.success) return;
        const row = MusicPlaylistRenderer.buildRow(result.event, index);
        if (!row) return;
        card.querySelector(`[data-slot="${index}"]`)?.replaceWith(row);
      })
    );
  }

  /**
   * Build a track row from a fetched kind-36787 event via the shared music
   * player (or null when the event carries no title/url at all). Rows keep
   * their a-tag position number so the list stays ordered after lazy fill.
   */
  private static buildRow(
    event: { tags: string[][] },
    index: number
  ): HTMLElement | null {
    const title = getTag(event.tags, 'title') || getTag(event.tags, 'd') || '';
    const url = getTag(event.tags, 'url');
    if (!title && !url) return null;
    const durationSec = Number(getTag(event.tags, 'duration'));
    const html = buildMusicTrackRowHtml({
      ref: url,
      title,
      durationSec:
        Number.isFinite(durationSec) && durationSec > 0
          ? Math.round(durationSec)
          : undefined,
      indexLabel: String(index + 1),
    });
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    return (tpl.content.firstElementChild as HTMLElement) ?? null;
  }
}
