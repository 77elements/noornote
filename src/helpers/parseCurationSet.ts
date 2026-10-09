/**
 * Shared CurationSet parser — NIP-51 article curation set (kind 30004).
 *
 * A curation set is a parameterized-replaceable event that curates other
 * addressable events via `a` tags, with `title` / `description` / `image`
 * metadata. Zap Cooking publishes these as "Recipe Packs" (the referenced
 * kind-30023 articles are recipes), other clients use them for generic
 * article collections.
 *
 * @used-by CurationSetProcessor, CurationSetRenderer, CurationSetItems
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { extractLinks } from './extractLinks';

export const CURATION_SET_KIND = 30004;

export interface CurationSetItemRef {
  kind: number;
  pubkey: string;
  identifier: string;
  /** Optional relay hint from the `a` tag's third value. */
  relay?: string;
}

export interface CurationSet {
  id: string; // d-tag
  eventId: string;
  title: string;
  description: string;
  coverImage: string;
  authorPubkey: string;
  createdAt: number;
  itemRefs: CurationSetItemRef[];
  /** First link found in the content (e.g. https://zap.cooking/pack/<naddr>), '' if none. */
  externalUrl: string;
}

function isAddressableKind(kind: number): boolean {
  return Number.isFinite(kind) && kind >= 30000 && kind <= 39999;
}

export function parseCurationSetEvent(event: NostrEvent): CurationSet {
  const tags = event.tags || [];
  const getTag = (name: string) => tags.find(t => t[0] === name)?.[1] || '';

  const itemRefs: CurationSetItemRef[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    if (tag[0] !== 'a' || !tag[1]) continue;
    const parts = tag[1].split(':');
    if (parts.length < 3) continue;
    const kind = Number(parts[0]);
    const pubkey = parts[1] ?? '';
    const identifier = parts.slice(2).join(':');
    if (!isAddressableKind(kind) || !pubkey || !identifier) continue;
    const coord = `${kind}:${pubkey}:${identifier}`;
    if (seen.has(coord)) continue;
    seen.add(coord);
    itemRefs.push({
      kind,
      pubkey,
      identifier,
      ...(tag[2] ? { relay: tag[2] } : {}),
    });
  }

  const firstLink = extractLinks(event.content || '')[0]?.url ?? '';

  return {
    id: getTag('d'),
    eventId: event.id || '',
    title: getTag('title') || 'Untitled collection',
    description: getTag('description') || '',
    coverImage: getTag('image') || '',
    authorPubkey: event.pubkey || '',
    createdAt: event.created_at ?? 0,
    itemRefs,
    externalUrl: firstLink,
  };
}
