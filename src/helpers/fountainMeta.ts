/**
 * Fountain.fm episode metadata fetcher.
 *
 * NIP-73 podcast tags only carry a GUID plus an (optional) URL hint — no title,
 * cover or audio. Fountain.fm episode pages are server-rendered with Open Graph
 * tags (og:title, og:image, og:audio = direct MP3, og:description) and send a
 * permissive CORS header, so a podcast card can be enriched entirely client-side
 * with no backend.
 *
 * Privacy: this is a direct outbound request to fountain.fm, so it leaks to
 * Fountain that the user is viewing this episode. It therefore runs LAZILY (only
 * when a podcast card actually scrolls into view, see PodcastCard) and never for
 * non-fountain hosts. Requests omit credentials so no cookies are sent.
 */

import { diagLog } from '../services/DiagnosticLogger';

export interface FountainMeta {
  /** Episode title (show name stripped off). */
  title?: string | undefined;
  /** Show / podcast name. */
  show?: string | undefined;
  /** Cover image URL. */
  image?: string | undefined;
  /** Direct audio (MP3) URL — playable inline. */
  audio?: string | undefined;
  /** Episode description. */
  description?: string | undefined;
}

// url → resolved meta (or null when it could not be fetched/parsed).
// A miss is cached too, so a failing card never re-hammers Fountain.
const cache = new Map<string, FountainMeta | null>();

/** True only for fountain.fm (and www.) URLs. Bounds the outbound surface. */
export function isFountainUrl(url: string): boolean {
  try {
    return new URL(url).hostname.replace(/^www\./, '') === 'fountain.fm';
  } catch {
    return false;
  }
}

/**
 * Fetch and parse Fountain episode metadata. Returns null on any failure
 * (non-fountain host, network/CORS error, missing tags). Results are cached.
 */
export async function fetchFountainMeta(url: string): Promise<FountainMeta | null> {
  if (cache.has(url)) return cache.get(url)!;
  if (!isFountainUrl(url)) {
    cache.set(url, null);
    return null;
  }

  try {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) {
      cache.set(url, null);
      return null;
    }
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const og = (prop: string) =>
      doc.querySelector(`meta[property="${prop}"]`)?.getAttribute('content')?.trim() || undefined;

    const rawTitle = og('og:title');
    const image = og('og:image');
    const audio = og('og:audio');
    const description = og('og:description');

    // Fountain's og:title is "Show • Episode • Listen on Fountain".
    let title = rawTitle;
    let show: string | undefined;
    if (rawTitle) {
      const parts = rawTitle
        .split('•')
        .map(s => s.trim())
        .filter(s => s && !/listen on fountain/i.test(s));
      if (parts.length >= 2) {
        show = parts[0];
        title = parts.slice(1).join(' • ');
      } else if (parts.length === 1) {
        title = parts[0];
      }
    }

    const meta: FountainMeta = { title, show, image, audio, description };
    cache.set(url, meta);
    diagLog('system', 'Podcast episode metadata fetched from fountain.fm', {
      hasTitle: !!title, hasImage: !!image, hasAudio: !!audio,
    });
    return meta;
  } catch {
    cache.set(url, null);
    diagLog('system', 'Podcast episode metadata fetch failed', { url });
    return null;
  }
}
