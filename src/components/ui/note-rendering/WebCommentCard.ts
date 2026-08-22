/**
 * WebCommentCard — renders the NIP-73 web-page reference of a NIP-22 comment
 * (kind:1111, `k:web`) as a small inline card appended to the note body, mirroring
 * PodcastCard. Additive: the rest of the note (text, quotes, media) renders as usual.
 *
 * Core, not opt-in: a web comment is a public event on the relays, so any client that
 * supports the kind shows it. The extension posts; NoorNote reads.
 *
 * Link-only, ZERO outbound: the card is built purely from the event's tags (icon +
 * "Commenting on" + domain + open link). It deliberately does NOT fetch Open Graph
 * metadata from the target URL — auto-fetching arbitrary user-supplied hosts would be
 * a fingerprinting / IP-leak surface (see docs/todos/web-comments.md privacy gate).
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { extractWebRef } from '../../../helpers/webContentTags';
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

/**
 * Build a web-comment card for an event, or null if it carries no NIP-73 web
 * reference (or the URL is unsafe).
 */
export function renderWebCommentCard(event: NostrEvent): HTMLElement | null {
  const ref = extractWebRef(event.tags);
  if (!ref) return null;

  const url = safeHttpUrl(ref.url) || null;
  if (!url) return null;

  const domain = hostLabel(url);

  const card = document.createElement('div');
  card.className = 'web-comment-card';
  card.innerHTML = `
    <div class="web-comment-card__media web-comment-card__media--empty">💬</div>
    <div class="web-comment-card__content">
      <span class="web-comment-card__kicker">Commenting on</span>
      <h3 class="web-comment-card__title">${escapeHtml(domain || url)}</h3>
      <a class="btn btn--mini web-comment-card__open" href="${escapeHtmlAttr(url)}" target="_blank" rel="noopener noreferrer">Open page →</a>
    </div>
  `;

  // Keep clicks inside the card (the open link) from bubbling up to the note-card,
  // which would otherwise navigate to the single-note view. Never swallow clicks on
  // note media — the global lightbox / video handlers must keep owning those.
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

  return card;
}
