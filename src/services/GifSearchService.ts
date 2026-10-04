/**
 * GifSearchService — client for the gifs.nostr.build GIF search API.
 *
 * Platform identification (per the integration guide — the first one present
 * decides alone):
 * - Web browsers: NO custom headers. The Origin header sent by the browser
 *   identifies the registered client (noornote.app; localhost works as the
 *   built-in development client).
 * - Electron: request runs in the MAIN process via IPC (`gif:search`) with the
 *   API key — the renderer's `file://` origin is not registrable and would
 *   make the server ignore a key anyway.
 * - Capacitor Android: `CapacitorHttp` (native HTTP stack, sends no Origin) with
 *   the API key baked into the bundle at APK build time (`__GNB_API_KEY__`).
 *   Without a key (dev builds) it falls back to plain fetch, which hits the API
 *   as the shared `https://localhost` development client.
 *
 * The API key must NEVER ship in the public web bundle — `__GNB_API_KEY__` is
 * only defined during APK builds, and the Electron key lives in the main
 * process (file/env), never in renderer code.
 *
 * Attribution requirement: the picker MUST show "GIFs from nostr.build" linked
 * to https://nostr.build (enforced in GifPicker, not here).
 */

import { PlatformService } from './PlatformService';
import { diagLog } from './DiagnosticLogger';
import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';
import {
  isGifMediaUrl,
  isSearchableGifQuery,
  type GifMeta,
} from '../helpers/gifImeta';

/** One GIF entry as returned by the search API. */
export interface GifItem {
  id: string;
  /** Original file URL — what gets posted in the note (never a preview). */
  url: string;
  width: number;
  height: number;
  frames: number | null;
  /** Seconds; may be null. */
  duration: number | null;
  bytes: number | null;
  /** `gif` or `webp`. */
  format: string;
  title: string;
  tags: string[];
  /** Tiny blurred placeholder as a data URI (or null). */
  lqip: string | null;
  /** H.264 conversion URL (ends in .gif on purpose) or null. */
  mp4: string | null;
  previews: {
    small?: GifPreview;
    medium?: GifPreview;
    w240?: GifPreview;
    w480?: GifPreview;
  };
}

export interface GifPreview {
  width: number;
  height: number;
  /** Animated WebP URL — may be null when the GIF is too large to animate. */
  animated: string | null;
  /** First frame PNG — poster/fallback. */
  still: string;
}

export interface GifSearchResult {
  /** The query as normalised by the server. */
  q: string;
  /** Total ranked-list length (max 200), for paging. */
  count: number;
  offset: number;
  /** Index build id — if it changes between pages, restart from offset 0. */
  build: string;
  items: GifItem[];
}

/** Typed API failure so the picker can show the right message. */
export type GifErrorCode =
  | 'validation'
  | 'client_not_registered'
  | 'rate_limited'
  | 'unavailable'
  | 'network';

export class GifSearchError extends Error {
  constructor(
    public readonly code: GifErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'GifSearchError';
  }
}

/** Autocomplete suggestion term. */
export interface GifSuggestion {
  term: string;
  kind: string;
}

const API_BASE = 'https://gifs.nostr.build/api/v1';
/** Guide: use a request timeout of about 15 s. */
const REQUEST_TIMEOUT_MS = 15_000;
/** In-memory answer cache keyed by normalised query (edge caches 1h, browser 5min). */
const MEMORY_CACHE_TTL_MS = 5 * 60 * 1000;
/** Cap for the per-account picked-GIF metadata cache (imeta source). */
const GIF_META_CACHE_MAX = 120;

interface CacheEntry {
  result: GifSearchResult;
  expiresAt: number;
}

export class GifSearchService {
  private static instance: GifSearchService;
  private platform: PlatformService;
  private cache = new Map<string, CacheEntry>();

  private constructor() {
    this.platform = PlatformService.getInstance();
  }

  public static getInstance(): GifSearchService {
    if (!GifSearchService.instance) {
      GifSearchService.instance = new GifSearchService();
    }
    return GifSearchService.instance;
  }

  /**
   * Search GIFs. Cached per normalised query (client-side, 5 min TTL) so
   * "Cat!" and "cat" share one entry. Throws GifSearchError on failure.
   */
  public async search(
    rawQuery: string,
    signal?: AbortSignal
  ): Promise<GifSearchResult> {
    const query = rawQuery.trim();
    if (!isSearchableGifQuery(query)) {
      throw new GifSearchError('validation', 'Query is not searchable');
    }

    const cacheKey = query.toLowerCase();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    const url = `${API_BASE}/search?q=${encodeURIComponent(query)}&limit=24`;
    const data = await this.request<GifSearchResult>(url, signal);

    // Defensive host validation on every media URL before it reaches the UI.
    const items = (data.items ?? []).filter(item => isGifMediaUrl(item.url));
    const result: GifSearchResult = { ...data, items };

    this.cache.set(cacheKey, {
      result,
      expiresAt: Date.now() + MEMORY_CACHE_TTL_MS,
    });
    if (this.cache.size > 60) {
      // Drop the oldest entry (insertion order = oldest first).
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return result;
  }

  /**
   * Autocomplete terms for the query (most used first). Best-effort: failures
   * resolve to an empty list so chips just stay empty.
   */
  public async suggest(
    rawQuery: string,
    signal?: AbortSignal
  ): Promise<string[]> {
    const query = rawQuery.trim();
    if (!isSearchableGifQuery(query)) return [];

    const url = `${API_BASE}/suggest?q=${encodeURIComponent(query)}&limit=8`;
    try {
      const data = await this.request<{ terms: GifSuggestion[] }>(url, signal);
      return (data.terms ?? []).map(t => t.term);
    } catch {
      return [];
    }
  }

  /** Clear the in-memory answer cache (e.g. after repeated 429s). */
  public clearCache(): void {
    this.cache.clear();
  }

  /**
   * Remember a picked GIF's metadata for the publish-time imeta tag
   * (per-account, capped — oldest entries drop off first).
   */
  public rememberGif(meta: GifMeta & { url: string }): void {
    try {
      const store = PerAccountLocalStorage.getInstance();
      const cache = store.get<Record<string, GifMeta>>(
        StorageKeys.GIF_META_CACHE,
        {}
      );
      // Re-insert to move the URL to the end (insertion order = recency).
      delete cache[meta.url];
      const entry: GifMeta = { m: meta.m, dim: meta.dim };
      if (typeof meta.size === 'number') entry.size = meta.size;
      if (meta.alt) entry.alt = meta.alt;
      cache[meta.url] = entry;
      const entries = Object.entries(cache);
      const trimmed =
        entries.length > GIF_META_CACHE_MAX
          ? entries.slice(entries.length - GIF_META_CACHE_MAX)
          : entries;
      store.set(StorageKeys.GIF_META_CACHE, Object.fromEntries(trimmed));
    } catch (error) {
      diagLog('system', 'gif_meta_cache_write_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Cached imeta metadata for one GIF URL (undefined when never picked). */
  public getGifMeta(url: string): GifMeta | undefined {
    try {
      const cache = PerAccountLocalStorage.getInstance().get<
        Record<string, GifMeta>
      >(StorageKeys.GIF_META_CACHE, {});
      return cache[url];
    } catch {
      return undefined;
    }
  }

  /**
   * Timeout guard for the web/capacitor paths. The caller's abort signal is
   * NOT passed into Electron IPC (AbortSignal does not survive structured
   * clone) — there the main process applies its own timeout; stale renderer
   * answers are dropped by the picker's request-id check instead.
   */
  private requestSignal(signal?: AbortSignal): AbortSignal | undefined {
    return this.platform.isElectron
      ? undefined
      : (signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS));
  }

  /**
   * Platform-routed GET returning parsed JSON. Maps every failure mode to a
   * GifSearchError with a code the picker can render.
   */
  private async request<T>(url: string, signal?: AbortSignal): Promise<T> {
    try {
      let response: Response;

      if (this.platform.isElectron) {
        // Main-process fetch with the API key (see electron/main/index.js).
        const electronAPI = window.electronAPI;
        if (!electronAPI) {
          throw new GifSearchError('network', 'Electron API unavailable');
        }
        const json = await electronAPI.gifSearch(url);
        return this.unwrapElectron<T>(json);
      }

      if (this.platform.isCapacitor) {
        response = await this.capacitorRequest(url);
      } else {
        // Web: plain fetch, no custom headers — Origin identifies us.
        const requestSignal = this.requestSignal(signal);
        response = await fetch(url, {
          ...(requestSignal ? { signal: requestSignal } : {}),
        });
      }

      if (!response.ok) throw await this.httpError(response);
      return (await response.json()) as T;
    } catch (error) {
      throw this.normalizeError(error);
    }
  }

  /** Capacitor Android: native HTTP with the build-time key (when present). */
  private async capacitorRequest(url: string): Promise<Response> {
    const apiKey = typeof __GNB_API_KEY__ === 'string' ? __GNB_API_KEY__ : '';
    const headers: Record<string, string> = apiKey
      ? { Authorization: `Bearer ${apiKey}` }
      : {};

    const { CapacitorHttp } = await import('@capacitor/core');
    const result = await CapacitorHttp.get({
      url,
      headers,
      readTimeout: REQUEST_TIMEOUT_MS,
    });

    // Re-wrap the native response as a fetch-like Response so the caller path
    // stays identical across platforms.
    const body =
      typeof result.data === 'string'
        ? result.data
        : JSON.stringify(result.data);
    return new Response(body, {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  }

  /** Electron IPC returns {status, body} from the main process. */
  private unwrapElectron<T>(json: { status: number; body: string }): T {
    if (json.status < 200 || json.status >= 300) {
      throw this.bodyError(json.status, json.body);
    }
    return JSON.parse(json.body) as T;
  }

  private async httpError(response: Response): Promise<GifSearchError> {
    let body = '';
    try {
      body = await response.text();
    } catch {
      // ignore — body is only used for the error code
    }
    return this.bodyError(response.status, body);
  }

  private bodyError(status: number, body: string): GifSearchError {
    let code = '';
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && 'error' in parsed) {
        const err = (parsed as { error: unknown }).error;
        if (err && typeof err === 'object' && 'code' in err) {
          const errCode = (err as { code: unknown }).code;
          if (typeof errCode === 'string') code = errCode;
        }
      }
    } catch {
      // non-JSON error body
    }
    if (status === 429 || code === 'rate_limited') {
      return new GifSearchError(
        'rate_limited',
        'Rate limited (Retry-After 60s)'
      );
    }
    if (status === 403 || code === 'client_not_registered') {
      return new GifSearchError(
        'client_not_registered',
        'Client not registered'
      );
    }
    if (status === 400 || code === 'validation') {
      return new GifSearchError('validation', 'Bad request');
    }
    return new GifSearchError('unavailable', `API error ${status}`);
  }

  /** Map aborts, network failures and CORS blocks to picker-friendly codes. */
  private normalizeError(error: unknown): GifSearchError {
    if (error instanceof GifSearchError) return error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      return new GifSearchError('network', 'Request aborted');
    }
    diagLog('system', 'gif_search_failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    // In browsers, 403/503 answered before CORS headers reach us as a bare
    // network error — the guide says to treat that as "unavailable, retry later".
    return new GifSearchError('network', 'Search request failed');
  }
}
