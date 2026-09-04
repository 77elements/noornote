/**
 * PodcastCard — renders a NIP-73 podcast reference (show / episode) as an
 * inline card inside a note. Additive: it is appended to a note's content,
 * the rest of the note (text, quotes, media) renders as usual.
 *
 * Boost consolidation (Fountain boosts): a boost note carries its message,
 * a naked URL hint, and a nostr:nevent reference to the kind-9735 zap receipt
 * that PAID for the boost. Instead of three scattered elements, everything is
 * folded into this one card:
 *  - the naked URL-hint link is removed (suppressPodcastUrlLinks) — the card's
 *    "Open on …" button covers it;
 *  - the zap amount is folded in as a "⚡ X sats" line (setPodcastCardZapSats,
 *    driven by QuotedNoteRenderer's kind-9735 branch via the skeleton's
 *    data-podcastBoost marker).
 *
 * Two states:
 *  - Basic (always, zero outbound): icon + "Podcast Episode" + a link to the
 *    URL hint. Built purely from the event's tags.
 *  - Rich (lazy, fountain.fm only): when the card scrolls into view we fetch the
 *    Fountain page's Open Graph tags and upgrade in place. The card becomes an
 *    `.nn-card` (same chrome as the article cards: cover on top, details in
 *    `.nn-card__content` below). See fountainMeta for the privacy note.
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

/** Boost amount (sats) per rendered card — survives renderRich's innerHTML rewrite. */
const zapSatsByCard = new WeakMap<HTMLElement, number>();

/** "⚡ 2 100 sats" — same amount formatting as ZapReceiptRenderer. */
export function formatZapSatsLine(sats: number): string {
  return `⚡ ${sats.toLocaleString()} sats`;
}

/**
 * Fold a boost zap amount into a podcast card as a "⚡ X sats" line.
 * Called by QuotedNoteRenderer when the host note is a NIP-73 boost and the
 * quoted kind-9735 receipt was fetched. No-op for non-positive amounts.
 */
export function setPodcastCardZapSats(card: HTMLElement, sats: number): void {
  if (!Number.isFinite(sats) || sats <= 0) return;
  zapSatsByCard.set(card, Math.floor(sats));
  syncZapLine(card);
}

/** Create/update the zap line in an already-rendered card (basic or rich). */
function syncZapLine(card: HTMLElement): void {
  const sats = zapSatsByCard.get(card);
  if (!sats) return;
  let line = card.querySelector<HTMLElement>('.podcast-card__zap');
  if (line) {
    line.textContent = formatZapSatsLine(sats);
    return;
  }
  const content = card.querySelector<HTMLElement>(
    '.nn-card__content, .podcast-card__content'
  );
  if (!content) return;
  line = document.createElement('div');
  line.className = card.classList.contains('podcast-card--rich')
    ? 'meta podcast-card__zap'
    : 'podcast-card__zap';
  line.textContent = formatZapSatsLine(sats);
  // Before the actions row when present, otherwise at the end.
  content.insertBefore(line, content.querySelector('.podcast-card__actions'));
}

/**
 * Remove anchors in the note body that exactly duplicate the NIP-73 URL hint —
 * the podcast card's "Open on …" button covers them. Blocks (<p>, <div>) that
 * become empty are collapsed so no blank gaps remain. Returns the removal count.
 */
export function removePodcastUrlLinks(
  container: HTMLElement,
  url: string
): number {
  let removed = 0;
  const anchors = Array.from(container.querySelectorAll('a')).filter(
    a => a.getAttribute('href') === url
  );
  for (const anchor of anchors) {
    const block = anchor.closest('p, div');
    anchor.remove();
    removed++;
    if (
      block &&
      !block.textContent?.trim() &&
      !block.querySelector('img, video, audio, svg, a')
    ) {
      block.remove();
    }
  }
  return removed;
}

/**
 * Suppress the naked URL-hint link of a podcast reference after the card (with
 * its "Open on …" button) was appended to the note.
 */
export function suppressPodcastUrlLinks(
  noteEl: HTMLElement,
  event: NostrEvent
): void {
  const ref = extractPodcastRef(event.tags);
  const url = ref?.url ? safeHttpUrl(ref.url) : null;
  if (!url) return;
  removePodcastUrlLinks(
    (noteEl.querySelector('.event-content') || noteEl) as HTMLElement,
    url
  );
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
      ${url ? `<a class="btn btn--mini" href="${escapeHtmlAttr(url)}" target="_blank" rel="noopener noreferrer">${openLabel}</a>` : ''}
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

export function renderRich(
  card: HTMLElement,
  url: string,
  isEpisode: boolean,
  meta: FountainMeta
): void {
  // Rich state swaps the compact basic card for the shared .nn-card chrome
  // (cover on top, details below — like the article cards). Podcast-specific
  // extras (kicker, actions, audio player) hang off .podcast-card--rich.
  card.className = 'nn-card podcast-card--rich';

  const image = meta.image ? safeHttpUrl(meta.image) : '';
  const audio = meta.audio ? safeHttpUrl(meta.audio) : '';
  const title = meta.title || hostLabel(url) || 'Podcast';
  const kicker = isEpisode ? 'Podcast Episode' : 'Podcast';
  const zapSats = zapSatsByCard.get(card) ?? 0;

  card.innerHTML = `
    ${
      image
        ? `<div class="nn-card__media"><img src="${escapeHtmlAttr(image)}" alt="${escapeHtmlAttr(title)}" loading="lazy" /></div>`
        : `<div class="nn-card__media nn-card__media--empty">🎙️</div>`
    }
    <div class="nn-card__content">
      <span class="podcast-card__kicker">${kicker}</span>
      <h3>${escapeHtml(title)}</h3>
      ${meta.show ? `<div class="meta">${escapeHtml(meta.show)}</div>` : ''}
      ${zapSats > 0 ? `<div class="meta podcast-card__zap">${formatZapSatsLine(zapSats)}</div>` : ''}
      <div class="podcast-card__actions">
        ${audio ? `<button class="btn btn--mini" data-action="podcast-play" type="button">▶ Play</button>` : ''}
        <a class="btn btn--mini" href="${escapeHtmlAttr(url)}" target="_blank" rel="noopener noreferrer">Open on ${escapeHtml(providerName(url))} →</a>
      </div>
    </div>
  `;

  if (audio) {
    const playBtn = card.querySelector('[data-action="podcast-play"]');
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
