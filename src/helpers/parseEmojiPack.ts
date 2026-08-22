/**
 * Shared NIP-30 emoji-pack parser. Extracts data from a kind:30030 emoji set event.
 *
 * @used-by EmojiPackProcessor / EmojiPackRenderer (note rendering of kind 30030)
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';

export interface EmojiPackEmoji {
  shortcode: string;
  url: string;
}

export interface EmojiPack {
  id: string; // d-tag
  eventId: string;
  title: string;
  authorPubkey: string;
  createdAt: number; // event.created_at (unix seconds)
  emojis: EmojiPackEmoji[];
}

export function parseEmojiPackEvent(event: NostrEvent): EmojiPack {
  const tags = event.tags || [];
  const getTag = (name: string) =>
    tags.find((t: string[]) => t[0] === name)?.[1] || '';

  return {
    id: getTag('d'),
    eventId: event.id || '',
    title: getTag('title') || getTag('name') || 'Emoji Pack',
    authorPubkey: event.pubkey || '',
    createdAt: (event as { created_at?: number }).created_at ?? 0,
    emojis: tags
      .filter(
        (t: string[]) => t[0] === 'emoji' && t.length >= 3 && t[1] && t[2]
      )
      .map((t: string[]) => ({ shortcode: t[1]!, url: t[2]! })),
  };
}
