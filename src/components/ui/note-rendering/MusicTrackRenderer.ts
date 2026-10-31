/**
 * MusicTrackRenderer — kind 36787 "Music Track" card (podtunes/nostria
 * convention). Cover, title, artist · album, duration and a native audio
 * player for the `url` tag. Reuses the `nn-card bookmark-list` markup/classes
 * so the ZapTrax playlist card and this card look and behave the same.
 * Display-only: NoorNote renders tracks, it does not author them.
 */

import { _ } from '../../../i18n';
import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { NoteHeader } from '../NoteHeader';
import {
  formatTrackDuration,
  isPlayableUrl,
} from '../../../helpers/parseBookmarkList';
import {
  MUSIC_TRACK_KIND,
  type MusicTrackData,
} from '../../../helpers/parseMusicTrack';
import { encodeNaddr } from '../../../services/NostrToolsAdapter';
import { getViewNavigationController } from '../../../services/ViewNavigationController';
import { escapeHtml, escapeHtmlAttr } from '../../../helpers/escapeHtml';
import { appendPackISL } from './packCardShared';

export class MusicTrackRenderer {
  static render(note: ProcessedNote, _opts: NoteUIOptions): HTMLElement {
    const event = note.rawEvent;
    const track = note.musicTrack;

    const element = document.createElement('div');
    element.className = 'note-card note-card--bookmark-list';
    element.dataset.eventId = note.id;

    const dTag = event.tags.find(t => t[0] === 'd')?.[1] ?? '';
    const naddr = encodeNaddr({
      kind: MUSIC_TRACK_KIND,
      pubkey: event.pubkey,
      identifier: dTag,
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

    const data: MusicTrackData = track ?? {
      id: dTag,
      title: '',
      url: '',
      zapSplits: [],
    };
    const coverImage = isPlayableUrl(data.image) ? (data.image ?? '') : '';
    const meta = [data.artist, data.album].filter(Boolean).join(' · ');
    const playable = isPlayableUrl(data.url);

    const card = document.createElement('div');
    card.className = 'nn-card bookmark-list';
    card.innerHTML = `
      <div class="${coverImage ? 'nn-card__media' : 'nn-card__media nn-card__media--empty'}">
        ${coverImage ? `<img src="${escapeHtmlAttr(coverImage)}" alt="${escapeHtmlAttr(data.alt || data.title)}" loading="lazy" />` : ''}
      </div>
      <div class="nn-card__content">
        <h3>${escapeHtml(data.title)}</h3>
        <div class="meta">${escapeHtml(_('Music track'))}${meta ? ` · ${escapeHtml(meta)}` : ''}${data.durationSec ? ` · ${escapeHtml(formatTrackDuration(data.durationSec))}` : ''}</div>
        ${playable ? MusicTrackRenderer.buildPlayerHtml(data) : ''}
      </div>
    `;

    if (playable) MusicTrackRenderer.wirePlayer(card);

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

  /** Audio element + one track row (same structure as the playlist card). */
  private static buildPlayerHtml(data: MusicTrackData): string {
    const duration = data.durationSec
      ? formatTrackDuration(data.durationSec)
      : '';
    return `
      <audio class="bookmark-list__player" controls preload="none"></audio>
      <ol class="bookmark-list__tracks">
        <li class="bookmark-list__track bookmark-list__track--playable"
            data-ref="${escapeHtmlAttr(data.url)}">
          <span class="bookmark-list__track-index">▶</span>
          <span class="bookmark-list__track-title">${escapeHtml(data.title)}</span>
          ${duration ? `<span class="bookmark-list__track-duration">${escapeHtml(duration)}</span>` : ''}
        </li>
      </ol>
    `;
  }

  /** Click a track row → load its URL into the shared player and play. */
  static wirePlayer(card: HTMLElement): void {
    const player = card.querySelector<HTMLAudioElement>(
      '.bookmark-list__player'
    );
    if (!player) return;
    card
      .querySelector('.bookmark-list__tracks')
      ?.addEventListener('click', e => {
        const row = (e.target as HTMLElement).closest<HTMLElement>(
          '.bookmark-list__track--playable'
        );
        if (!row) return;
        const url = row.dataset.ref ?? '';
        if (!isPlayableUrl(url)) return;
        if (player.getAttribute('src') !== url) {
          player.setAttribute('src', url);
        }
        void player.play();
      });
  }
}
