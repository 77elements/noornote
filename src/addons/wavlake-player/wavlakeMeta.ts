/**
 * Wavlake track metadata fetcher.
 *
 * API: GET https://wavlake.com/api/v1/content/track/{id}
 * CORS is open (`access-control-allow-origin: *`), so this works client-side with
 * no backend. Rate-limit is 30/min → results (incl. misses) are cached.
 *
 * Privacy: a direct outbound request to wavlake.com leaks the user's IP + track
 * interest. It therefore runs LAZILY (only when a card scrolls into view, or on
 * tap in data-saver mode — see WavlakeCard). Credentials omitted.
 */
import { diagLog } from '../../services/DiagnosticLogger';

export interface WavlakeTrack {
  title: string;
  artist: string;
  artistNpub?: string | undefined;
  albumArtUrl?: string | undefined;
  albumTitle?: string | undefined;
  mediaUrl?: string | undefined;
  duration?: number | undefined;
}

const API_BASE = 'https://wavlake.com/api/v1/content/track/';
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// id → resolved track (or null on failure). Misses are cached too, so a failing
// card never re-hammers the rate-limited API.
const cache = new Map<string, WavlakeTrack | null>();

/** Drop all cached tracks — called on addon destroy (account switch / toggle off). */
export function clearWavlakeMetaCache(): void {
  cache.clear();
}

/**
 * Strip the op3.dev analytics redirect, returning the direct CDN media URL.
 * `https://op3.dev/e,pg=…/https://cdn…/track.mp3` → `https://cdn…/track.mp3`.
 */
export function stripOp3Prefix(url: string): string {
  const stripped = url.replace(/^https?:\/\/op3\.dev\/[^/]+\//, '');
  return /^https?:\/\//.test(stripped) ? stripped : url;
}

/**
 * Fetch + parse Wavlake track metadata. Returns null on any failure. Cached.
 */
export async function fetchWavlakeTrack(id: string): Promise<WavlakeTrack | null> {
  if (cache.has(id)) return cache.get(id)!;
  if (!UUID_RE.test(id)) {
    cache.set(id, null);
    return null;
  }

  try {
    const res = await fetch(API_BASE + id, { credentials: 'omit' });
    if (!res.ok) {
      cache.set(id, null);
      return null;
    }
    const data = await res.json();
    // The API returns an array-with-one-object OR a bare object — handle both.
    const o = Array.isArray(data) ? data[0] : data;
    if (!o || typeof o !== 'object') {
      cache.set(id, null);
      return null;
    }

    const track: WavlakeTrack = {
      title: o.title || 'Untitled',
      artist: o.artist || '',
      artistNpub: o.artistNpub || undefined,
      albumArtUrl: o.albumArtUrl || undefined,
      albumTitle: o.albumTitle || undefined,
      mediaUrl: o.mediaUrl || undefined,
      duration: typeof o.duration === 'number' ? o.duration : undefined,
    };
    cache.set(id, track);
    diagLog('system', 'Wavlake track metadata fetched', { id });
    return track;
  } catch {
    cache.set(id, null);
    diagLog('system', 'Wavlake track metadata fetch failed', { id });
    return null;
  }
}
