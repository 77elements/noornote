/**
 * BlossomResolver — BUD-10 `blossom:` URI resolution (read side).
 *
 * Walks the BUD-10 candidate order to turn a content-addressed blob reference
 * into a concrete https URL:
 *
 *   1. `xs` server hints from the URI (in declaration order)
 *   2. kind:10063 (BUD-03) server lists of the URI's `as` authors, plus an
 *      optional contextual author hint (the note's author)
 *   3. the locally-configured upload server, when it speaks blossom
 *
 * Every candidate is probed with a BUD-01 HEAD request (short timeout). Images
 * are additionally downloaded fully and SHA-256-verified (spec: clients SHOULD
 * verify); verified blobs are served from an object URL. Video/audio resolve
 * to the plain server URL so the native players can stream via range requests —
 * full-buffer verification is impossible while streaming, so for those only
 * the content-length is sanity-checked against the URI's `sz` when present.
 *
 * Reference: Amethyst's BlossomServerResolver (cache / miss-cache / in-flight
 * dedup pattern), BUD-10, BUD-03, NIP-B7.
 */

import { diagLog } from './DiagnosticLogger';
import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';
import { RelayConfig } from './RelayConfig';
import { NostrTransport } from './transport/NostrTransport';
import {
  blobUrlFor,
  renderTypeForContentType,
  renderTypeForExt,
  type BlossomUriInfo,
} from '../helpers/blossomUri';

export interface BlossomResolution {
  /** Blossom server that answered. */
  serverUrl: string;
  /** Direct BUD-01 blob URL on that server (unverified content). */
  blobUrl: string;
  /**
   * URL to hand to <img>/<video>/<audio>. Images: a verified object URL
   * (SHA-256 checked). Video/audio: {@link blobUrl} (range-streamed).
   */
  contentUrl: string;
  /** True when {@link contentUrl} is hash-verified. */
  verified: boolean;
  /** Render type decided at probe time (content-type, then extension). */
  type: 'image' | 'video' | 'audio' | 'epub';
}

/** Read one media-server setting the same way MediaUploadService does. */
interface MediaServerSettings {
  url: string;
  protocol: 'blossom' | 'nip96';
}

const HEAD_TIMEOUT_MS = 4_000;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const LIST_TIMEOUT_MS = 5_000;
/** Negative-result TTL — don't re-probe a failed URI on every scroll frame. */
const MISS_TTL_MS = 30_000;
/** kind:10063 server-list TTL. */
const SERVER_LIST_TTL_MS = 5 * 60_000;

export class BlossomResolver {
  private static instance: BlossomResolver;
  private transport: NostrTransport;
  private relayConfig: RelayConfig;

  private cache = new Map<string, BlossomResolution>();
  private missCache = new Map<string, number>();
  private inflight = new Map<string, Promise<BlossomResolution | null>>();
  private serverLists = new Map<
    string,
    { servers: string[]; fetchedAt: number }
  >();

  constructor(transport?: NostrTransport, relayConfig?: RelayConfig) {
    this.transport = transport ?? NostrTransport.getInstance();
    this.relayConfig = relayConfig ?? RelayConfig.getInstance();
  }

  static getInstance(): BlossomResolver {
    if (!BlossomResolver.instance) {
      BlossomResolver.instance = new BlossomResolver();
    }
    return BlossomResolver.instance;
  }

  /** Test hook: forget every cache. */
  clearCaches(): void {
    this.cache.clear();
    this.missCache.clear();
    this.inflight.clear();
    this.serverLists.clear();
  }

  /**
   * Resolve a parsed blossom URI to a concrete server/blob URL.
   * Never throws — returns null when no candidate server has the blob.
   */
  async resolve(
    info: BlossomUriInfo,
    opts?: { authorHint?: string }
  ): Promise<BlossomResolution | null> {
    const cached = this.cache.get(info.raw);
    if (cached) return cached;

    const missedAt = this.missCache.get(info.raw);
    if (missedAt && Date.now() - missedAt < MISS_TTL_MS) return null;

    const pending = this.inflight.get(info.raw);
    if (pending) return pending;

    const task = this.resolveInner(info, opts).finally(() => {
      this.inflight.delete(info.raw);
    });
    this.inflight.set(info.raw, task);
    return task;
  }

  private async resolveInner(
    info: BlossomUriInfo,
    opts?: { authorHint?: string }
  ): Promise<BlossomResolution | null> {
    const candidates = await this.buildCandidateServers(info, opts?.authorHint);

    for (const server of candidates) {
      const blobUrl = blobUrlFor(server, info);
      const head = await this.probe(blobUrl, info);
      if (!head) continue;

      if (head.type === 'image') {
        const verified = await this.downloadAndVerify(blobUrl, info);
        if (!verified) continue; // hash or size mismatch — try next server
        const resolution: BlossomResolution = {
          serverUrl: server,
          blobUrl,
          contentUrl: verified,
          verified: true,
          type: 'image',
        };
        this.cache.set(info.raw, resolution);
        return resolution;
      }

      // Video/audio/unknown: resolve to the direct URL for range-streaming.
      const resolution: BlossomResolution = {
        serverUrl: server,
        blobUrl,
        contentUrl: blobUrl,
        verified: false,
        type: head.type,
      };
      this.cache.set(info.raw, resolution);
      return resolution;
    }

    this.missCache.set(info.raw, Date.now());
    diagLog(
      'system',
      'BlossomResolver: blob not found on any candidate server',
      { uri: info.raw, candidates: candidates.length }
    );
    return null;
  }

  /**
   * Candidate order per BUD-10: xs hints → authors' kind:10063 lists →
   * locally configured blossom upload server. Deduped, order preserved.
   */
  private async buildCandidateServers(
    info: BlossomUriInfo,
    authorHint?: string
  ): Promise<string[]> {
    const candidates: string[] = [...info.servers];

    const authors = [...info.authors];
    if (authorHint && !authors.includes(authorHint.toLowerCase())) {
      authors.push(authorHint.toLowerCase());
    }
    for (const pubkey of authors) {
      for (const server of await this.fetchServerList(pubkey)) {
        if (!candidates.includes(server)) candidates.push(server);
      }
    }

    const own = this.ownBlossomServer();
    if (own && !candidates.includes(own)) candidates.push(own);

    return candidates;
  }

  /** Fetch and cache a user's BUD-03 kind:10063 server list. */
  private async fetchServerList(pubkey: string): Promise<string[]> {
    const cached = this.serverLists.get(pubkey);
    if (cached && Date.now() - cached.fetchedAt < SERVER_LIST_TTL_MS) {
      return cached.servers;
    }

    let servers: string[] = [];
    try {
      const events = await this.transport.fetch(
        this.relayConfig.getReadRelays(),
        [{ kinds: [10063], authors: [pubkey], limit: 1 }],
        LIST_TIMEOUT_MS,
        false,
        'BlossomResolver'
      );
      const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
      if (latest) {
        servers = latest.tags
          .filter(tag => tag[0] === 'server' && !!tag[1])
          .map(tag => tag[1]!.replace(/\/+$/, ''));
      }
    } catch {
      // Transport never throws in practice; treat as empty list.
    }
    this.serverLists.set(pubkey, { servers, fetchedAt: Date.now() });
    return servers;
  }

  /** The locally-configured upload server, when it's a blossom one. */
  private ownBlossomServer(): string | null {
    try {
      const settings = PerAccountLocalStorage.getInstance().get<
        MediaServerSettings | undefined
      >(StorageKeys.MEDIA_SERVER, undefined);
      if (settings?.protocol === 'blossom' && settings.url) {
        return settings.url.replace(/\/+$/, '');
      }
    } catch {
      // Not logged in / storage unavailable — no own server then.
    }
    return null;
  }

  /**
   * BUD-01 probe. Returns the render type decision payload on success
   * (200 + matching content-length), null on any failure.
   */
  private async probe(
    blobUrl: string,
    info: BlossomUriInfo
  ): Promise<{ type: 'image' | 'video' | 'audio' | 'epub' } | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS);
      const response = await fetch(blobUrl, {
        method: 'HEAD',
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!response.ok) return null;

      if (info.size !== undefined) {
        const length = Number(response.headers.get('content-length'));
        if (Number.isFinite(length) && length > 0 && length !== info.size) {
          return null; // wrong blob on this server
        }
      }

      const contentType = response.headers.get('content-type');
      return {
        type: contentType
          ? renderTypeForContentType(contentType)
          : renderTypeForExt(info.ext),
      };
    } catch {
      return null;
    }
  }

  /**
   * Full download + SHA-256 verification for image-type blobs. Returns an
   * object URL of the verified bytes, or null on mismatch/transfer failure.
   */
  private async downloadAndVerify(
    blobUrl: string,
    info: BlossomUriInfo
  ): Promise<string | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
      const response = await fetch(blobUrl, { signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) return null;

      const buffer = await response.arrayBuffer();

      if (info.size !== undefined && buffer.byteLength !== info.size) {
        return null;
      }

      const digest = await crypto.subtle.digest('SHA-256', buffer);
      const hex = Array.from(new Uint8Array(digest))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
      if (hex !== info.hash) return null;

      return URL.createObjectURL(
        new Blob([buffer], {
          type:
            response.headers.get('content-type') || 'application/octet-stream',
        })
      );
    } catch {
      return null;
    }
  }
}
