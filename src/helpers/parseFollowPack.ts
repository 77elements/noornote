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
  createdAt: number;    // event.created_at (unix timestamp)
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
    createdAt: (event as any).created_at ?? 0,
    userPubkeys: tags.filter((t: string[]) => t[0] === 'p' && t[1]).map((t: string[]) => t[1]!),
  };
}

/**
 * Manually curated blacklist of packs to hide.
 * Key format: `authorPubkey:d-tag` (stable across updates)
 */
const BLACKLISTED_PACKS = new Set<string>([
  '7c43cf89d4fce44812d76def0377bc1b3f02756b27ab5207f0ba2dbe8718e4ae:cphk7xlq93m5', // boobstr
]);

export function filterFollowPacks(packs: FollowPack[]): FollowPack[] {
  const filtered = packs.filter(pack => {
    const title = pack.title.toLowerCase();
    if (title.includes('spam') || pack.userPubkeys.length === 0 || pack.title.length === 0) return false;
    if (BLACKLISTED_PACKS.has(`${pack.authorPubkey}:${pack.id}`)) return false;
    return true;
  });

  // Deduplicate by title + author + member count
  const seen = new Set<string>();
  const deduped = filtered.filter(pack => {
    const key = `${pack.title.toLowerCase()}|${pack.authorPubkey}|${pack.userPubkeys.length}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped.sort((a, b) => b.createdAt - a.createdAt);
}
