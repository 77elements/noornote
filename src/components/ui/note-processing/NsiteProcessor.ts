/**
 * NsiteProcessor — NIP-5A static website manifests (nsites).
 *
 * Two kinds:
 * - 15128 root site manifest (replaceable, no `d` tag, one per pubkey)
 * - 35128 named site manifest (addressable, `d` tag). ⚠️ Kind 35128 is SHARED
 *   with Satellite Earth's proprietary site settings — NIP-5A manifests are
 *   told apart by their mandatory `path` tags (`isNsiteManifest`).
 *
 * The event body is always empty (a manifest is a file listing, not text), so
 * the note content carries the site title for previews/snippets; the full card
 * (file list, gateway link) is built by NsiteRenderer from the tags.
 *
 * Deliberate exclusions (NIP-5A is `draft` — display-side support only):
 * - NOT added to the FeedOrchestrator kinds filter: manifests are not social
 *   content; they reach the user via reposts, quotes and direct opens.
 * - No publishing support (no own-nsite management).
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { ProcessedNote } from '../types/NoteTypes';

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

export class NsiteProcessor {
  static process(event: NostrEvent): ProcessedNote {
    const eventId = event.id;
    if (!eventId) throw new Error('Event ID is required');

    const title = event.tags.find(t => t[0] === 'title')?.[1]?.trim();

    return {
      id: eventId,
      type: 'nsite',
      timestamp: event.created_at,
      author: { pubkey: event.pubkey },
      content: {
        text: title || 'Nostr website',
        html: '',
        media: [],
        links: [],
        hashtags: [],
        quotedReferences: [],
        bolt11Invoices: [],
      },
      rawEvent: event,
    };
  }
}
