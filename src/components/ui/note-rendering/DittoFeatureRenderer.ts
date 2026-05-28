/**
 * DittoFeatureRenderer - Notice card for Ditto's proprietary geocache listings.
 *
 * Kind 37516 is a Ditto-only ("ditto.pub") feature with no NIP and no place in
 * the Nostr standard. Other clients can't render it meaningfully, so instead of
 * dumping raw JSON / an empty body we show a short notice plus a link that opens
 * the event in Ditto via its naddr coordinate.
 *
 * Scope is deliberately limited to 37516: we don't know the kind numbers or URL
 * shapes of Ditto's other proprietary types, so we don't pretend to handle them.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { encodeNaddr } from '../../../services/NostrToolsAdapter';
import { getTag } from '../../../helpers/tagUtils';
import { escapeHtmlAttr } from '../../../helpers/escapeHtml';

/** Ditto's proprietary geocache listing kind (addressable, no NIP). */
export const DITTO_GEOCACHE_KIND = 37516;

export class DittoFeatureRenderer {
  /** Render the notice from a full event (reads the `d` tag for the naddr). */
  static render(event: NostrEvent): HTMLElement {
    return DittoFeatureRenderer.renderCard(
      event.kind ?? DITTO_GEOCACHE_KIND,
      event.pubkey,
      getTag(event.tags, 'd'),
      event.id,
    );
  }

  /** Render the notice from a decoded naddr coordinate (no event fetched). */
  static renderFromCoordinate(kind: number, pubkey: string, identifier: string): HTMLElement {
    return DittoFeatureRenderer.renderCard(kind, pubkey, identifier);
  }

  private static renderCard(kind: number, pubkey: string, identifier: string, eventId?: string): HTMLElement {
    const element = document.createElement('div');
    element.className = 'note-card note-card--unsupported';
    if (eventId) element.dataset.eventId = eventId;

    const naddr = encodeNaddr({ kind, pubkey, identifier, relays: [] });
    const dittoUrl = `https://ditto.pub/${naddr}`;

    element.innerHTML = `
      <div class="unsupported-kind">
        <div class="unsupported-kind__message">
          <strong>📍 Geocache · Ditto</strong><br>
          This is a proprietary Ditto feature and not part of the Nostr standard.
        </div>
        <a href="${escapeHtmlAttr(dittoUrl)}" target="_blank" rel="noopener noreferrer" class="btn">
          ↗ Open in Ditto
        </a>
      </div>
    `;

    return element;
  }
}
