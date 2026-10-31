/**
 * parseMusicTrack — parsers for the Nostr music kinds published by
 * podtunes/nostria/Wavlake-style clients (ZapTrax NIP conventions, listed in
 * the Nostr Event Kinds Registry):
 *
 * - kind 36787 "Music Track": addressable event whose tags carry the track
 *   metadata (`title`, `url` (audio), `image`, `artist`, `album`,
 *   `track_number`, `duration` (seconds), `license`, `zap` splits, `alt`).
 * - kind 34139 "Music Playlist": addressable event referencing tracks via
 *   `a` tags shaped `36787:<pubkey>:<d-tag>`.
 *
 * Pure tag parsing — no relay IO, no DOM.
 */

export const MUSIC_TRACK_KIND = 36787;
export const MUSIC_PLAYLIST_KIND = 34139;

/** Upper bound so a malicious/giant playlist can't explode the renderer. */
const MAX_TRACKS = 200;

export interface MusicTrackData {
  /** `d` tag identifier. */
  id: string;
  /** `title` tag, falling back to the `d` identifier. */
  title: string;
  /** Audio file URL from the `url` tag (may be empty — unplayable track). */
  url: string;
  /** Cover/artwork URL from the `image` tag. */
  image?: string | undefined;
  artist?: string | undefined;
  album?: string | undefined;
  /** Position in the album, from the `track_number` tag. */
  trackNumber?: number | undefined;
  /** Length in seconds, from the `duration` tag. */
  durationSec?: number | undefined;
  /** `license` tag (free text, e.g. "All Rights Reserved"). */
  license?: string | undefined;
  /** Zap split destinations (pubkey or lightning address, `zap` tag value 1). */
  zapSplits: string[];
  /** NIP-31 alt description. */
  alt?: string | undefined;
}

export interface MusicPlaylistData {
  /** `d` tag identifier. */
  id: string;
  title: string;
  image?: string | undefined;
  /** Referenced tracks as `a`-tag coordinates `36787:<pubkey>:<d-tag>`. */
  trackRefs: string[];
}

function tagValue(tags: string[][], name: string): string {
  return tags.find(t => t[0] === name)?.[1] ?? '';
}

/** Parse a kind-36787 event. Returns null when it carries no title/url at all. */
export function parseMusicTrack(event: {
  tags: string[][];
  pubkey: string;
}): MusicTrackData | null {
  const tags = event.tags || [];
  const id = tagValue(tags, 'd');
  const title = tagValue(tags, 'title');
  const url = tagValue(tags, 'url');
  if (!id && !title && !url) return null;

  const trackNumber = Number(tagValue(tags, 'track_number'));
  const durationSec = Number(tagValue(tags, 'duration'));
  return {
    id,
    title: title || id,
    url,
    image: tagValue(tags, 'image') || undefined,
    artist: tagValue(tags, 'artist') || undefined,
    album: tagValue(tags, 'album') || undefined,
    trackNumber:
      Number.isFinite(trackNumber) && trackNumber > 0 ? trackNumber : undefined,
    durationSec:
      Number.isFinite(durationSec) && durationSec > 0
        ? Math.round(durationSec)
        : undefined,
    license: tagValue(tags, 'license') || undefined,
    zapSplits: tags
      .filter(t => t[0] === 'zap' && t[1])
      .map(t => t[1] as string),
    alt: tagValue(tags, 'alt') || undefined,
  };
}

/** Parse a kind-34139 playlist event: title/image + `36787:…` track references. */
export function parseMusicPlaylist(event: {
  tags: string[][];
  pubkey: string;
}): MusicPlaylistData {
  const tags = event.tags || [];
  const id = tagValue(tags, 'd');
  const trackRefs: string[] = [];
  for (const tag of tags) {
    if (tag[0] === 'a' && tag[1]?.startsWith(`${MUSIC_TRACK_KIND}:`)) {
      if (trackRefs.length >= MAX_TRACKS) break;
      if (!trackRefs.includes(tag[1])) trackRefs.push(tag[1]);
    }
  }
  return {
    id,
    title: tagValue(tags, 'title') || id,
    image: tagValue(tags, 'image') || undefined,
    trackRefs,
  };
}

/** Split an `a`-tag coordinate into its pubkey and d-tag parts. */
export function splitTrackRef(
  ref: string
): { pubkey: string; identifier: string } | null {
  const [, pubkey, identifier] = ref.split(':');
  if (!pubkey || !identifier) return null;
  return { pubkey, identifier };
}
