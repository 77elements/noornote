/**
 * GatedNoteRenderer — renders fanfares-style gated premium notes
 * (kind 1 + ["encrypted","aes-256-gcm",…] + ["price",N,"SATS"] tags).
 *
 * The real content is encrypted inside the tag; the public `content` is a
 * teaser ending in a SELF-REFERENTIAL fanfares.io CTA (the URL's naddr
 * encodes the same event). Rendering that CTA as a quote reference recurses
 * forever — so gated notes render as a CARD (teaser + unlock CTA) with NO
 * nested quote references, everywhere (quote boxes, TV, SNV). Unlocking is
 * delegated to fanfares.io (external CTA).
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote, NoteUIOptions } from '../types/NoteTypes';
import { NoteStructureBuilder } from './NoteStructureBuilder';
import { NoteHeader } from '../NoteHeader';
import {
  getGatedNotePrice,
  stripGatedNoteCta,
  buildFanfaresUrl,
} from '../../../helpers/gatedNote';
import { escapeHtmlAttr } from '../../../helpers/escapeHtml';
import { formatNumberWithCommas } from '../../../helpers/zapUtils';
import { ContentProcessor } from '../../../services/ContentProcessor';
import { replaceMediaPlaceholders } from '../../../helpers/renderMediaContent';

/** CTA badge + link — shared by the quote card and the full note shell. */
function buildCtaHtml(event: NostrEvent): string {
  const price = getGatedNotePrice(event) ?? 0;
  const url = buildFanfaresUrl(event);
  if (!url) return '';
  return `<div class="gated-note__cta"><span class="badge badge--warning">⚡ ${formatNumberWithCommas(price)} sats</span><a class="btn btn--medium" href="${escapeHtmlAttr(url)}" target="_blank" rel="noopener noreferrer" data-gated-cta>Unlock on fanfares.io&nbsp;↗</a></div>`;
}

/** Teaser body — CTA lines stripped (the CTA lives in the badge/link above).
 *  Media URLs (glued or not) render through the standard media pipeline. */
function buildTeaserHtml(event: NostrEvent): string {
  const teaser = stripGatedNoteCta(event.content ?? '');
  if (!teaser) return '';
  const processed = contentProcessor.processContent(teaser);
  const isNSFW = event.tags?.some(tag => tag[0] === 'content-warning') ?? false;
  return `<div class="event-content gated-note__teaser">${replaceMediaPlaceholders(
    processed.html,
    processed.media,
    isNSFW,
    event.id ?? '',
    event.pubkey
  )}</div>`;
}

const contentProcessor = ContentProcessor.getInstance();

export class GatedNoteRenderer {
  /**
   * Light card for quote boxes (and any non-root surface): header + teaser +
   * unlock CTA. No nested quote references — the recursion killer.
   */
  static renderQuoteCard(event: NostrEvent): HTMLElement {
    const card = document.createElement('div');
    card.className = 'gated-note-card';
    const eventId = event.id ?? '';
    if (eventId) card.dataset.eventId = eventId;

    const header = new NoteHeader({
      pubkey: event.pubkey,
      eventId,
      timestamp: event.created_at,
      rawEvent: event,
      showVerification: false,
      showTimestamp: true,
      showMenu: true,
    });
    card.appendChild(header.getElement());

    const body = document.createElement('div');
    body.innerHTML = `${buildTeaserHtml(event)}${buildCtaHtml(event)}`;
    card.appendChild(body);

    // Inviolable media-click rule: never pre-empt image/video handlers.
    card.addEventListener('click', e => {
      const target = e.target as HTMLElement;
      if (
        target.closest('.note-image--clickable') ||
        target.closest('.note-media') ||
        target.tagName === 'VIDEO'
      ) {
        return;
      }
      const url = buildFanfaresUrl(event);
      if (url) {
        e.stopPropagation();
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    });

    return card;
  }

  /**
   * Full note shell (TV/SNV root notes): standard header + ISL via
   * NoteStructureBuilder, content replaced by teaser + unlock CTA.
   */
  static render(note: ProcessedNote, opts: NoteUIOptions): HTMLElement {
    const { element } = NoteStructureBuilder.build(
      note,
      {
        cssClass: 'note-card--gated',
        footerLabel: '',
        renderQuotedNotes: false,
      },
      opts
    );

    const contentEl = element.querySelector('.event-content');
    const ctaHtml = buildCtaHtml(note.rawEvent);
    if (contentEl) {
      contentEl.classList.add('gated-note__teaser');
      contentEl.insertAdjacentHTML('afterend', ctaHtml);
    } else {
      element.insertAdjacentHTML('beforeend', ctaHtml);
    }
    return element;
  }
}
