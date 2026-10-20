/**
 * Shared bookmark-list parser — NIP-51 categorized bookmark list (kind 30003).
 *
 * A bookmark set is a parameterized-replaceable event with `e` / `a` / `r` item
 * tags. NoorNote uses it natively for its own bookmark folders; third-party
 * clients reuse the same kind for media collections — ZapTrax publishes
 * playlists as `d=playlist-*` sets whose tracks travel as `r` tags (audio URLs)
 * with `track-title` / `track-artist` / `track-image` / `track-duration` /
 * `track-feed-id` companion tags keyed by the same URL.
 *
 * The parser is renderer-agnostic: it only decides the display label
 * ("Playlist" when track metadata is present, "Bookmark list" otherwise) and
 * extracts the metadata. No fetching, no DOM.
 *
 * @used-by BookmarkListCardRenderer
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';

export const BOOKMARK_SET_KIND = 30003;

/** Cap on parsed tracks — protects against pathological events. */
const MAX_TRACKS = 200;

export interface BookmarkListTrack {
  /** The shared reference (typically an audio URL from an `r` tag). */
  ref: string;
  title: string;
  artist: string;
  durationSec?: number;
  image?: string;
}

export interface BookmarkList {
  /** `d` tag identifier. */
  id: string;
  /** `title` tag, falling back to the `d` identifier. */
  title: string;
  /** True when track metadata tags are present (ZapTrax-style playlist). */
  isPlaylist: boolean;
  /** Distinct `e` / `a` / `r` item references. */
  itemCount: number;
  tracks: BookmarkListTrack[];
  authorPubkey: string;
  createdAt: number;
}

/**
 * Tag value for companion metadata tags. ZapTrax's shape is
 * `["track-x", <shared-ref>, <value>]`; a plain `["track-x", <value>]` shape
 * is tolerated for other publishers.
 */
function companionValue(tag: string[]): string {
  return tag[2] ?? tag[1] ?? '';
}

export function parseBookmarkSetEvent(event: NostrEvent): BookmarkList {
  const tags = event.tags || [];
  const dTag = tags.find(t => t[0] === 'd')?.[1] || '';
  const titleTag = tags.find(t => t[0] === 'title')?.[1] || '';

  const itemCount = new Set<string>();
  for (const tag of tags) {
    if ((tag[0] === 'e' || tag[0] === 'a' || tag[0] === 'r') && tag[1]) {
      itemCount.add(tag[1]);
    }
  }

  // Group companion track tags by their shared reference.
  const byRef = new Map<string, BookmarkListTrack>();
  for (const tag of tags) {
    if (tag[0] !== 'track-title' || byRef.size >= MAX_TRACKS) continue;
    const ref = tag[1] ?? '';
    const track: BookmarkListTrack = byRef.get(ref) ?? {
      ref,
      title: '',
      artist: '',
    };
    track.title = companionValue(tag);
    byRef.set(ref, track);
  }
  for (const tag of tags) {
    if (tag[0] !== 'track-artist' || !byRef.has(tag[1] ?? '')) continue;
    byRef.get(tag[1] ?? '')!.artist = companionValue(tag);
  }
  for (const tag of tags) {
    if (tag[0] !== 'track-duration' || !byRef.has(tag[1] ?? '')) continue;
    const seconds = Number(companionValue(tag));
    if (Number.isFinite(seconds) && seconds > 0) {
      byRef.get(tag[1] ?? '')!.durationSec = Math.round(seconds);
    }
  }
  for (const tag of tags) {
    if (tag[0] !== 'track-image' || !byRef.has(tag[1] ?? '')) continue;
    byRef.get(tag[1] ?? '')!.image = companionValue(tag);
  }

  const tracks = [...byRef.values()].filter(t => t.title || t.artist);

  return {
    id: dTag,
    title: titleTag || dTag,
    isPlaylist: tracks.length > 0,
    itemCount: Math.max(itemCount.size, tracks.length),
    tracks,
    authorPubkey: event.pubkey,
    createdAt: event.created_at,
  };
}

/** Formats seconds as `m:ss` (or `h:mm:ss` beyond an hour); `0:00` for invalid input. */ export function formatTrackDuration(
  seconds: number
): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/**
 * True only for ABSOLUTE http(s) URLs. Item refs in bookmark lists are
 * frequently event ids or coordinates — those must never be treated as
 * playable/cover URLs (safeHttpUrl would resolve them against the app origin).
 */
export function isPlayableUrl(ref: string | undefined): boolean {
  if (!ref) return false;
  try {
    const url = new URL(ref);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
