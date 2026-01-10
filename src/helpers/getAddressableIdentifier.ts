/**
 * Extract addressable identifier (a-tag) from a Nostr event
 * For use with addressable/replaceable events (kinds 30000-39999)
 *
 * @param event - Nostr event
 * @returns Addressable identifier in format "kind:pubkey:d-tag" or null
 *
 * @example
 * // Long-form article (kind 30023)
 * const aTag = getAddressableIdentifier(event);
 * // Returns: "30023:a1b2c3...:my-article-slug"
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';

export function getAddressableIdentifier(event: NostrEvent): string | null {
  const kind = event.kind;
  // Only addressable events (kinds 30000-39999) have addressable identifiers
  if (kind === undefined || kind < 30000 || kind > 39999) {
    return null;
  }

  // Find d-tag (identifier tag)
  const dTag = event.tags.find(tag => tag[0] === 'd');
  if (!dTag || !dTag[1]) {
    return null;
  }

  // Build addressable identifier: "kind:pubkey:d-tag"
  const identifier = `${kind}:${event.pubkey}:${dTag[1]}`;
  return identifier;
}
