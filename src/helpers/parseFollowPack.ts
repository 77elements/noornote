/**
 * Shared FollowPack parser
 * Extracts FollowPack data from Kind 39089 Nostr events
 *
 * @used-by FollowPackManager, AccountSetupWizard
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';

export interface FollowPack {
  id: string;           // d-tag
  eventId: string;
  title: string;
  description: string;
  coverImage: string;
  authorPubkey: string;
  authorName?: string;
  userPubkeys: string[];
  userProfiles?: Map<string, { name?: string; picture?: string; about?: string }>;
}

export function parseFollowPackEvent(event: NostrEvent): FollowPack {
  const tags = event.tags || [];
  const getTag = (name: string) => tags.find((t: string[]) => t[0] === name)?.[1] || '';

  return {
    id: getTag('d'),
    eventId: event.id || '',
    title: getTag('title') || getTag('n') || 'Untitled',
    description: getTag('description') || '',
    coverImage: getTag('image') || '',
    authorPubkey: event.pubkey || '',
    userPubkeys: tags.filter((t: string[]) => t[0] === 'p' && t[1]).map((t: string[]) => t[1]!),
  };
}

export function filterFollowPacks(packs: FollowPack[]): FollowPack[] {
  return packs
    .filter(pack => {
      const title = pack.title.toLowerCase();
      return !title.includes('spam') && pack.userPubkeys.length > 0 && pack.title.length > 0;
    })
    .sort((a, b) => b.userPubkeys.length - a.userPubkeys.length);
}
