/**
 * NIP-73 podcast reference extraction.
 *
 * NIP-73 ("External Content IDs") tags a note with `i`/`k` pairs that point at
 * non-Nostr content. For podcasts the namespaces are:
 *   - podcast:guid           → a whole show / feed
 *   - podcast:item:guid      → a single episode
 *   - podcast:publisher:guid → a publisher (ignored here, nothing to render)
 *
 * Each `i` tag is `["i", "<value>", "<url-hint?>"]`. The url hint is OPTIONAL
 * (NIP-73 "MAY") and points to a human-facing page (typically fountain.fm).
 *
 * NIP-22 comments (kind 1111) on external content carry the same data in the
 * uppercase root-scope tags `I`/`K`, so we accept both casings.
 */

export interface PodcastRef {
  /** GUID of the episode (podcast:item:guid), if present. */
  episodeGuid?: string | undefined;
  /** GUID of the show/feed (podcast:guid), if present. */
  showGuid?: string | undefined;
  /** Best human-facing URL hint (episode preferred over show). */
  url?: string | undefined;
}

const EPISODE_PREFIX = 'podcast:item:guid:';
const SHOW_PREFIX = 'podcast:guid:';

/**
 * Extract a podcast reference from a note's tags, or null if the note carries
 * no NIP-73 podcast identifier. Reads both lowercase (`i`) and uppercase (`I`,
 * NIP-22 root scope) tags.
 */
export function extractPodcastRef(tags: string[][]): PodcastRef | null {
  let episode: { guid: string; url?: string | undefined } | undefined;
  let show: { guid: string; url?: string | undefined } | undefined;

  for (const tag of tags) {
    if (tag[0] !== 'i' && tag[0] !== 'I') continue;
    const value = tag[1] || '';
    const url = tag[2] || undefined;
    // Episode prefix must be checked first — it also starts with "podcast:".
    if (value.startsWith(EPISODE_PREFIX)) {
      if (!episode) episode = { guid: value.slice(EPISODE_PREFIX.length), url };
    } else if (value.startsWith(SHOW_PREFIX)) {
      if (!show) show = { guid: value.slice(SHOW_PREFIX.length), url };
    }
  }

  if (!episode && !show) return null;

  return {
    episodeGuid: episode?.guid,
    showGuid: show?.guid,
    url: episode?.url || show?.url,
  };
}
