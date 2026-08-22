/**
 * PodcastCard — renders a NIP-73 podcast reference (show / episode) as an
 * inline card inside a note. Additive: it is appended to a note's content,
 * the rest of the note (text, quotes, media) renders as usual.
 *
 * Two states:
 *  - Basic (always, zero outbound): icon + "Podcast Episode" + a link to the
 *    URL hint. Built purely from the event's tags.
 *  - Rich (lazy, fountain.fm only): when the card scrolls into view we fetch the
 *    Fountain page's Open Graph tags and upgrade in place with cover, title,
 *    show name and an inline play button. See fountainMeta for the privacy note.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { extractPodcastRef } from '../../../helpers/podcastTags';
import {
  fetchFountainMeta,
  isFountainUrl,
  type FountainMeta,
} from '../../../helpers/fountainMeta';
import {
  escapeHtml,
  escapeHtmlAttr,
  safeHttpUrl,
} from '../../../helpers/escapeHtml';

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Title-case a bare domain for button copy ("fountain.fm" → "Fountain"). */
function providerName(url: string): string {
  const host = hostLabel(url);
  const base = host.split('.')[0] || host;
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : host;
}

/**
 * Build a podcast card for an event, or null if it carries no NIP-73 podcast
 * reference.
 */
export function renderPodcastCard(event: NostrEvent): HTMLElement | null {
  const ref = extractPodcastRef(event.tags);
  if (!ref) return null;

  const url = ref.url ? safeHttpUrl(ref.url) || null : null;
  const isEpisode = !!ref.episodeGuid;

  const card = document.createElement('div');
  card.className = 'podcast-card';
  card.innerHTML = basicMarkup(isEpisode, url);

  // Keep clicks inside the card (play button, open link) from bubbling up to
  // the note-card, which would otherwise navigate to the single-note view.
  // Never swallow clicks on note media — the global lightbox / video handlers
  // must keep owning those (inviolable media-click rule).
  card.addEventListener('click', e => {
    const target = e.target as HTMLElement;
    if (
      target.closest('.note-image--clickable') ||
      target.closest('.note-media') ||
      target.closest('video')
    ) {
      return;
    }
    e.stopPropagation();
  });

  // Lazy rich upgrade — only for fountain.fm hints, only once visible.
  if (url && isFountainUrl(url)) {
    upgradeWhenVisible(card, url, isEpisode);
  }

  return card;
}

function basicMarkup(isEpisode: boolean, url: string | null): string {
  const kicker = isEpisode ? 'Podcast Episode' : 'Podcast';
  const domain = url ? hostLabel(url) : '';
  const openLabel = url ? `Open on ${escapeHtml(providerName(url))} →` : '';
  return `
    <div class="podcast-card__media podcast-card__media--empty">🎙️</div>
    <div class="podcast-card__content">
      <span class="podcast-card__kicker">${kicker}</span>
      <h3 class="podcast-card__title">${domain ? escapeHtml(domain) : 'Podcast'}</h3>
      ${url ? `<a class="btn btn--mini podcast-card__open" href="${escapeHtmlAttr(url)}" target="_blank" rel="noopener noreferrer">${openLabel}</a>` : ''}
    </div>
  `;
}

function upgradeWhenVisible(
  card: HTMLElement,
  url: string,
  isEpisode: boolean
): void {
  const observer = new IntersectionObserver(
    (entries, obs) => {
      if (!entries.some(e => e.isIntersecting)) return;
      obs.disconnect();
      void fetchFountainMeta(url).then(meta => {
        // Bail if nothing useful came back or the card left the DOM meanwhile.
        if (!meta || !document.contains(card)) return;
        if (!meta.title && !meta.image && !meta.audio) return;
        renderRich(card, url, isEpisode, meta);
      });
    },
    { rootMargin: '200px' }
  );
  observer.observe(card);
}

function renderRich(
  card: HTMLElement,
  url: string,
  isEpisode: boolean,
  meta: FountainMeta
): void {
  card.classList.add('podcast-card--rich');

  const image = meta.image ? safeHttpUrl(meta.image) : '';
  const audio = meta.audio ? safeHttpUrl(meta.audio) : '';
  const title = meta.title || hostLabel(url) || 'Podcast';
  const kicker = isEpisode ? 'Podcast Episode' : 'Podcast';

  card.innerHTML = `
    ${
      image
        ? `<div class="podcast-card__media"><img src="${escapeHtmlAttr(image)}" alt="${escapeHtmlAttr(title)}" loading="lazy" /></div>`
        : `<div class="podcast-card__media podcast-card__media--empty">🎙️</div>`
    }
    <div class="podcast-card__content">
      <span class="podcast-card__kicker">${kicker}</span>
      <h3 class="podcast-card__title">${escapeHtml(title)}</h3>
      ${meta.show ? `<p class="podcast-card__show">${escapeHtml(meta.show)}</p>` : ''}
      <div class="podcast-card__actions">
        ${audio ? `<button class="btn btn--mini podcast-card__play" type="button">▶ Play</button>` : ''}
        <a class="btn btn--mini podcast-card__open" href="${escapeHtmlAttr(url)}" target="_blank" rel="noopener noreferrer">Open on ${escapeHtml(providerName(url))} →</a>
      </div>
    </div>
  `;

  if (audio) {
    const playBtn = card.querySelector('.podcast-card__play');
    playBtn?.addEventListener('click', () => {
      const player = document.createElement('audio');
      player.controls = true;
      player.preload = 'metadata';
      player.src = audio;
      player.className = 'podcast-card__audio';
      playBtn.replaceWith(player);
      // Kick off playback explicitly — the click is a user gesture so this is
      // allowed; swallow the rejection if the browser still declines.
      void player.play().catch(() => {});
    });
  }
}
