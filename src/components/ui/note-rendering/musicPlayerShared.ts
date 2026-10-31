/**
 * Shared native audio player for music-ish cards (kind 30003 ZapTrax
 * playlists, kind 36787 tracks, kind 34139 playlists — and future services).
 * One markup + one wiring for all of them: an <audio> element plus track rows
 * (`bookmark-list__*` classes, styled once for the bookmark-list card) where
 * clicking a playable row assigns its URL to the shared player and plays.
 *
 * Rows are pure HTML strings so lazy renderers (playlist → fetch tracks
 * later) can swap placeholder rows after the fact via <template>.
 */

import {
  formatTrackDuration,
  isPlayableUrl,
} from '../../../helpers/parseBookmarkList';
import { escapeHtml, escapeHtmlAttr } from '../../../helpers/escapeHtml';

export interface MusicPlayerRow {
  /** Audio file URL (validated with isPlayableUrl; non-http refs render inert). */
  ref: string;
  title: string;
  /** Optional second label part, joined as "title — artist". */
  artist?: string | undefined;
  /** Length in seconds; formatted via formatTrackDuration. */
  durationSec?: number | undefined;
  /** Index-slot content: "1", "2", … in lists, "▶" on a single-track card. */
  indexLabel: string;
}

/** One track row. Non-playable refs render without the playable affordance. */
export function buildMusicTrackRowHtml(row: MusicPlayerRow): string {
  const playable = isPlayableUrl(row.ref);
  const label = [row.title, row.artist].filter(Boolean).join(' — ');
  const duration =
    row.durationSec && row.durationSec > 0
      ? formatTrackDuration(row.durationSec)
      : '';
  return `
        <li class="bookmark-list__track${playable ? ' bookmark-list__track--playable' : ''}"
            data-ref="${escapeHtmlAttr(row.ref)}">
          <span class="bookmark-list__track-index">${escapeHtml(row.indexLabel)}</span>
          <span class="bookmark-list__track-title">${escapeHtml(label || row.ref)}</span>
          ${duration ? `<span class="bookmark-list__track-duration">${escapeHtml(duration)}</span>` : ''}
        </li>`;
}

/** Shared <audio> player + track rows (same shape as the ZapTrax card). */
export function buildMusicPlayerHtml(rows: MusicPlayerRow[]): string {
  const rowHtml = rows.map(row => buildMusicTrackRowHtml(row)).join('');
  return `
      <audio class="bookmark-list__player" controls preload="none"></audio>
      <ol class="bookmark-list__tracks">${rowHtml}</ol>
    `;
}

/**
 * Click a track row → load its URL into the shared player and play. Bound on
 * the row container (event delegation), so lazily added rows work unchanged.
 */
export function wireMusicPlayer(card: HTMLElement): void {
  const player = card.querySelector<HTMLAudioElement>('.bookmark-list__player');
  if (!player) return;
  card.querySelector('.bookmark-list__tracks')?.addEventListener('click', e => {
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
