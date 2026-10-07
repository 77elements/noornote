/**
 * NsiteRenderer - Notice card for NIP-5A static websites (nsites).
 *
 * NIP-5A (draft) hosts static websites on Blossom: a manifest event maps URL
 * paths to sha256 blob hashes (`["path", "/index.html", "<hash>"]`), plus
 * optional `title` / `description` / `server` / `source` tags. The body is
 * always empty — a nsite is not readable content, it is a file listing. So
 * instead of the bare "unsupported kind" card we show the site title and a
 * link that opens the site on a public nsite gateway.
 *
 * Kinds:
 * - 15128 root site (replaceable, no `d` tag) — one site per pubkey. Gateway
 *   label is the npub (`https://<npub>.nsite.run/`).
 * - 35128 named site (addressable, `d` tag). ⚠️ Kind 35128 is SHARED with
 *   Satellite Earth's proprietary site settings (see SatelliteSiteRenderer).
 *   NIP-5A manifests MUST carry `path` tags, Satellite Earth settings don't —
 *   that tag is the discriminator (`isNsiteManifest`). Canonical gateway label
 *   per NIP-5A: base36(pubkey) + d-tag.
 *
 * The link is a plain external anchor opened by the user — no automatic fetch
 * to the gateway or the `server` Blossom hints (privacy: zero outbound calls).
 *
 * Mirrors `SatelliteSiteRenderer` / `DittoFeatureRenderer` — same problem
 * class, same solution shape.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { hexToNpub } from '../../../helpers/nip19';
import { getTag } from '../../../helpers/tagUtils';
import { escapeHtml, escapeHtmlAttr } from '../../../helpers/escapeHtml';

/** NIP-5A root site manifest (replaceable, no `d` tag). */
export const NSITE_ROOT_KIND = 15128;

/** NIP-5A named site manifest (addressable, `d` tag) — shared with Satellite Earth. */
export const NSITE_NAMED_KIND = 35128;

function hasPathTags(event: NostrEvent): boolean {
  return event.tags.some(tag => tag[0] === 'path');
}

/**
 * True when the event is a NIP-5A site manifest: kind 15128 always, kind 35128
 * only when it carries the mandatory `path` tags (else it is a Satellite Earth
 * settings event and stays with SatelliteSiteRenderer).
 */
export function isNsiteManifest(event: NostrEvent): boolean {
  if (event.kind === NSITE_ROOT_KIND) return true;
  if (event.kind === NSITE_NAMED_KIND) return hasPathTags(event);
  return false;
}

/** NIP-5A canonical gateway label: npub for root, base36(pubkey)+dTag for named. */
function buildNsiteUrl(event: NostrEvent): string {
  if (!event.pubkey) return '';
  if (event.kind === NSITE_NAMED_KIND) {
    const base36 = BigInt(`0x${event.pubkey}`).toString(36);
    const dTag = getTag(event.tags, 'd') || '';
    return `https://${base36}${dTag}.nsite.run/`;
  }
  const npub = hexToNpub(event.pubkey);
  return npub ? `https://${npub}.nsite.run/` : '';
}

export class NsiteRenderer {
  static render(event: NostrEvent): HTMLElement {
    const title = getTag(event.tags, 'title');
    const description = getTag(event.tags, 'description');
    const pathCount = event.tags.filter(tag => tag[0] === 'path').length;
    const url = buildNsiteUrl(event);
    const displayTitle = title?.trim() || 'Nostr website';

    const element = document.createElement('div');
    element.className = 'note-card note-card--unsupported';
    if (event.id) element.dataset.eventId = event.id;

    element.innerHTML = `
      <div class="unsupported-kind">
        <div class="unsupported-kind__message">
          <strong>🌐 nsite · ${escapeHtml(displayTitle)}</strong>${
            description?.trim() ? `<br>${escapeHtml(description.trim())}` : ''
          }<br>
          <span class="unsupported-kind__meta">NIP-5A static website · ${pathCount} file${pathCount === 1 ? '' : 's'} on Blossom servers</span>
        </div>
        ${
          url
            ? `
        <a href="${escapeHtmlAttr(url)}" target="_blank" rel="noopener noreferrer" class="btn">
          ↗ Open website
        </a>
        `
            : ''
        }
      </div>
    `;

    return element;
  }
}
