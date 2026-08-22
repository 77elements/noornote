/**
 * SatelliteSiteRenderer - Notice card for Satellite Earth personal-site pages.
 *
 * Kind 35129 is a Satellite Earth ("cdn.satellite.earth") feature with no NIP
 * and no place in the Nostr standard. It encodes one page / file of a user's
 * Nostr-native personal website (Satellite Earth's "NAP" protocol, archetype
 * "NAP-4"). The body is opaque to NoorNote — we don't fetch from the
 * `server` tag or parse the `path` / `x` tags — so instead of dumping raw
 * JSON or an empty body, we show the page title (from the `title` tag) plus
 * a link that opens the naddr coordinate on njump, the universal viewer.
 *
 * Scope is deliberately limited to 35129: Satellite Earth's other NAP kinds
 * (if any) have not been verified, so we don't pretend to handle them.
 *
 * Mirrors `DittoFeatureRenderer` (kind 37516) — same problem class, same
 * solution shape.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { encodeNaddr, noteEncode } from '../../../services/NostrToolsAdapter';
import { QuoteNoteFetcher } from '../../../services/QuoteNoteFetcher';
import { getTag } from '../../../helpers/tagUtils';
import { escapeHtml, escapeHtmlAttr } from '../../../helpers/escapeHtml';

/** Satellite Earth personal-site page kind (addressable, no NIP). */
export const SATELLITE_SITE_KIND = 35129;

/**
 * Satellite Earth's `/thread/` viewer expects a NIP-19 note1 (raw event id).
 * It rejects naddr1 ("invalid note ID") because the naddr coordinate has no
 * event id. Confirmed working: `satellite.earth/thread/<note1>`.
 */
function buildSatelliteThreadUrl(eventId: string): string {
  const note1 = noteEncode(eventId);
  return `https://satellite.earth/thread/${note1}`;
}

export class SatelliteSiteRenderer {
  /** Render the notice from a full event (has the id → direct Satellite URL). */
  static render(event: NostrEvent): HTMLElement {
    const dTag = getTag(event.tags, 'd');
    const title = getTag(event.tags, 'title');
    return SatelliteSiteRenderer.renderCard(
      event.kind ?? SATELLITE_SITE_KIND,
      event.pubkey,
      dTag,
      title,
      event.id
    );
  }

  /**
   * Render the notice from a decoded naddr coordinate (no event fetched yet).
   *
   * The coordinate has no event id, so we can't build the canonical
   * `satellite.earth/thread/<nevent>` URL up front. Render the card with a
   * njump fallback link immediately, then kick off a background fetch via
   * QuoteNoteFetcher to resolve the event id and upgrade the link to the
   * direct Satellite Earth URL once it arrives. If the fetch fails or the
   * element has been detached by then, the njump fallback stays in place.
   */
  static renderFromCoordinate(
    kind: number,
    pubkey: string,
    identifier: string
  ): HTMLElement {
    const element = SatelliteSiteRenderer.renderCard(kind, pubkey, identifier);
    if (kind !== SATELLITE_SITE_KIND) return element;

    const naddr = encodeNaddr({ kind, pubkey, identifier, relays: [] });
    const link = element.querySelector('a[href]');
    if (link) {
      void QuoteNoteFetcher.getInstance()
        .fetchQuotedEventWithError(`nostr:${naddr}`)
        .then(result => {
          if (!element.isConnected) return;
          if (result.success && result.event.id) {
            link.setAttribute('href', buildSatelliteThreadUrl(result.event.id));
          }
        })
        .catch(() => {
          /* leave njump fallback in place */
        });
    }
    return element;
  }

  private static renderCard(
    kind: number,
    pubkey: string,
    identifier: string,
    title?: string,
    eventId?: string
  ): HTMLElement {
    const element = document.createElement('div');
    element.className = 'note-card note-card--unsupported';
    if (eventId) element.dataset.eventId = eventId;

    const displayTitle = title?.trim() || identifier || 'Untitled page';
    const naddr = encodeNaddr({ kind, pubkey, identifier, relays: [] });
    // When we have the event id → direct Satellite Earth nevent URL.
    // Otherwise → njump fallback (gets upgraded async by renderFromCoordinate).
    const href = eventId
      ? buildSatelliteThreadUrl(eventId)
      : `https://njump.me/${naddr}`;

    element.innerHTML = `
      <div class="unsupported-kind">
        <div class="unsupported-kind__message">
          <strong>🛰️ Satellite Earth page · ${escapeHtml(displayTitle)}</strong><br>
          This is a page on a Satellite Earth personal site and not part of the Nostr standard.
        </div>
        <a href="${escapeHtmlAttr(href)}" target="_blank" rel="noopener noreferrer" class="btn">
          ↗ Open on Satellite Earth
        </a>
      </div>
    `;

    return element;
  }
}
