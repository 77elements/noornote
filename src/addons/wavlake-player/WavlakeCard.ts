/**
 * WavlakeCard — renders a `wavlake.com/track/{id}` link as an inline music card
 * appended to a note's content (additive, like PodcastCard).
 *
 * States:
 *  - Skeleton (sync): cover placeholder + "Wavlake" kicker + Loading…
 *  - Rich (lazy): cover, title, clickable artist (→ Nostr profile), Play + duration.
 *    Fetched when the card scrolls into view; in data-saver mode it stays a
 *    tap-to-load skeleton (no outbound until the user taps).
 *  - Audio uses `preload="none"` so the (op3.dev / CDN) mp3 is only fetched on a
 *    deliberate Play click. op3.dev redirect is stripped unless the user opted in.
 */
import { fetchWavlakeTrack, stripOp3Prefix, type WavlakeTrack } from './wavlakeMeta';
import { isWavlakeKeepOp3Enabled } from './index';
import { isDataSaverEnabled } from '../../services/DataSaverService';
import { escapeHtml, escapeHtmlAttr, safeHttpUrl } from '../../helpers/escapeHtml';

function fmtDuration(sec?: number): string {
  if (!sec || sec < 0) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function renderWavlakeCard(trackId: string): HTMLElement {
  const card = document.createElement('div');
  card.className = 'wavlake-card';

  // Keep clicks inside the card (play, artist link) from bubbling to the
  // note-card, which would navigate to the single-note view. Never swallow
  // note-media clicks — the global lightbox / video handlers own those
  // (inviolable media-click rule).
  card.addEventListener('click', e => {
    const target = e.target as HTMLElement;
    if (target.closest('.note-image--clickable') || target.closest('.note-media') || target.closest('video')) {
      return;
    }
    e.stopPropagation();
  });

  if (isDataSaverEnabled()) {
    card.innerHTML = skeletonMarkup(true);
    const loadBtn = card.querySelector('.wavlake-card__load');
    loadBtn?.addEventListener('click', () => { void hydrate(card, trackId); });
  } else {
    card.innerHTML = skeletonMarkup(false);
    upgradeWhenVisible(card, trackId);
  }

  return card;
}

function skeletonMarkup(tapToLoad: boolean): string {
  return `
    <div class="wavlake-card__media wavlake-card__media--empty">🎵</div>
    <div class="wavlake-card__content">
      <span class="wavlake-card__kicker">Wavlake</span>
      ${tapToLoad
        ? `<button class="btn btn--mini wavlake-card__load" type="button">Load track</button>`
        : `<h3 class="wavlake-card__title pulsate">Loading…</h3>`}
    </div>
  `;
}

function upgradeWhenVisible(card: HTMLElement, trackId: string): void {
  const observer = new IntersectionObserver((entries, obs) => {
    if (!entries.some(e => e.isIntersecting)) return;
    obs.disconnect();
    void hydrate(card, trackId);
  }, { rootMargin: '200px' });
  observer.observe(card);
}

async function hydrate(card: HTMLElement, trackId: string): Promise<void> {
  const track = await fetchWavlakeTrack(trackId);
  if (!document.contains(card)) return;
  if (!track) {
    renderFailed(card);
    return;
  }
  renderRich(card, track);
}

function renderFailed(card: HTMLElement): void {
  card.innerHTML = `
    <div class="wavlake-card__media wavlake-card__media--empty">🎵</div>
    <div class="wavlake-card__content">
      <span class="wavlake-card__kicker">Wavlake</span>
      <h3 class="wavlake-card__title">Track unavailable</h3>
    </div>
  `;
}

function renderRich(card: HTMLElement, track: WavlakeTrack): void {
  card.classList.add('wavlake-card--rich');

  const cover = track.albumArtUrl ? safeHttpUrl(track.albumArtUrl) : '';
  const duration = fmtDuration(track.duration);
  const artistMarkup = track.artistNpub
    ? `<a class="wavlake-card__artist" href="/profile/${escapeHtmlAttr(track.artistNpub)}">${escapeHtml(track.artist)}</a>`
    : `<span class="wavlake-card__artist">${escapeHtml(track.artist)}</span>`;

  card.innerHTML = `
    ${cover
      ? `<div class="wavlake-card__media"><img src="${escapeHtmlAttr(cover)}" alt="${escapeHtmlAttr(track.title)}" loading="lazy" /></div>`
      : `<div class="wavlake-card__media wavlake-card__media--empty">🎵</div>`}
    <div class="wavlake-card__content">
      <span class="wavlake-card__kicker">Wavlake${track.albumTitle ? ` · ${escapeHtml(track.albumTitle)}` : ''}</span>
      <h3 class="wavlake-card__title">${escapeHtml(track.title)}</h3>
      ${track.artist ? `<p class="wavlake-card__by">${artistMarkup}</p>` : ''}
      <div class="wavlake-card__actions">
        ${track.mediaUrl ? `<button class="btn btn--mini wavlake-card__play" type="button">▶ Play${duration ? ` · ${duration}` : ''}</button>` : ''}
      </div>
    </div>
  `;

  if (track.mediaUrl) {
    const rawUrl = track.mediaUrl;
    const playBtn = card.querySelector('.wavlake-card__play');
    playBtn?.addEventListener('click', () => {
      const src = isWavlakeKeepOp3Enabled() ? rawUrl : stripOp3Prefix(rawUrl);
      const safe = safeHttpUrl(src);
      if (!safe) return;
      const player = document.createElement('audio');
      player.controls = true;
      player.preload = 'none';
      player.src = safe;
      player.className = 'wavlake-card__audio';
      playBtn.replaceWith(player);
      // Explicit play — the click is a user gesture; swallow a declined promise.
      void player.play().catch(() => {});
    });
  }
}
