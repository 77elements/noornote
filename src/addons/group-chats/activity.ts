/**
 * Pure classification of NIP-29 group chat activity for one poll window.
 *
 * Two signals matter more than generic "something happened":
 * - Mention: someone else's event carries a p tag on the user's pubkey.
 * - Reply: someone else's event quotes/replies to one of the user's events
 *   via a q/e tag whose AUTHOR element is the user's pubkey
 *   (["q", eventId, relayUrl, authorPubkey] / ["e", eventId, relayUrl, author?]).
 *   A q/e tag without an author element cannot be attributed, so it is
 *   deliberately NOT counted — a bare event id says nothing about who was
 *   replied to, and guessing would produce false "reply" notifications for
 *   every unrelated thread reference in the group.
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';

export interface GroupActivityClassification {
  mentions: NostrEvent[];
  replies: NostrEvent[];
}

export function classifyActivity(
  events: NostrEvent[],
  me: string
): GroupActivityClassification {
  const mentions: NostrEvent[] = [];
  const replies: NostrEvent[] = [];
  for (const e of events) {
    if (e.pubkey === me) continue; // own events never notify
    if (e.tags.some(t => t[0] === 'p' && t[1] === me)) {
      mentions.push(e);
      continue;
    }
    const refersToMe = e.tags.some(
      t => (t[0] === 'q' || t[0] === 'e') && (t[2] === me || t[3] === me)
    );
    if (refersToMe) replies.push(e);
  }
  return { mentions, replies };
}
