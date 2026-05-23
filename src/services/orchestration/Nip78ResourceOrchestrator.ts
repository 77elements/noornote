/**
 * Nip78ResourceOrchestrator
 *
 * Generic NIP-78 (kind:30078) publish/fetch/sync/delete pipeline. Wrapped
 * by every NosPress per-resource orchestrator (Menu, PageIndex, Site
 * Settings, Page body) — they used to be near-identical 150-line files,
 * now they are 40–60 LOC config + thin glue around this class.
 *
 * Design constraints captured here:
 *   - cross-device discovery via OutboundRelaysOrchestrator (NIP-65);
 *   - 60s LRU per `(pubkey, key)` to absorb quick re-mounts without
 *     re-hitting relays;
 *   - replaceable-event semantics: cache the latest by `created_at`,
 *     publish-then-invalidate;
 *   - sign via AuthService (never `finalizeEvent` directly), publish via
 *     NostrTransport (never `ndkEvent.publish`);
 *   - destroy clears the cache only — persistent NIP-78 state on relays
 *     is never touched.
 *
 * Key model: `key` is an opaque string. Most NosPress resources have a
 * static d-tag → use `''`. The page-body orchestrator uses the page slug
 * (and header/footer suffixes) → its config returns a different d-tag per
 * key, and the cache stores per `(pubkey, key)`.
 */

import { NostrTransport } from '../transport/NostrTransport';
import { AuthService } from '../AuthService';
import { OutboundRelaysOrchestrator } from './OutboundRelaysOrchestrator';
import { SystemLogger } from '../../components/system/SystemLogger';
import { DeletionService } from '../DeletionService';
import { diagLog } from '../DiagnosticLogger';

const NIP78_KIND = 30078;
const DEFAULT_TTL_MS = 60000;
const FETCH_TIMEOUT_MS = 5000;

export interface Nip78ResourceConfig<T> {
  /** Used in SystemLogger / diagLog messages. e.g. 'NospressMenuOrchestrator'. */
  name: string;
  /** Used as the source-tag in NostrTransport.fetch. e.g. 'NospressMenuOrch'. */
  fetchLabel: string;
  /** Resolve the d-tag for a given key. Static-d-tag resources ignore the
   *  argument and return a fixed string. Slug-aware resources branch on it. */
  dTagFor: (key: string) => string;
  /** Parse the NIP-78 event content into the domain type, or null on invalid. */
  parse: (content: string) => T | null;
  /** Optional cache TTL override. Default 60s. */
  cacheTtlMs?: number;
}

interface CacheEntry<T> {
  data: T | null;
  fetchedAt: number;
}

export class Nip78ResourceOrchestrator<T> {
  private cache = new Map<string, CacheEntry<T>>();

  constructor(private readonly cfg: Nip78ResourceConfig<T>) {}

  /** Drop all cached entries. Used by the addon runtime's destroy(). */
  public destroyCache(): void {
    this.cache.clear();
  }

  /** Selective invalidation. Pass no pubkey to flush everything. */
  public clearCache(pubkey?: string): void {
    if (!pubkey) {
      this.cache.clear();
      return;
    }
    for (const k of Array.from(this.cache.keys())) {
      if (k === pubkey || k.startsWith(`${pubkey}::`)) this.cache.delete(k);
    }
  }

  /** Single-key invalidation — used after publish so the next fetch sees fresh state. */
  public invalidate(pubkey: string, key: string = ''): void {
    this.cache.delete(this.cacheKey(pubkey, key));
  }

  public async fetch(pubkey: string, key: string = '', forceRefresh: boolean = false): Promise<T | null> {
    const ck = this.cacheKey(pubkey, key);
    if (!forceRefresh) {
      const cached = this.cache.get(ck);
      if (cached && (Date.now() - cached.fetchedAt) < this.ttl()) return cached.data;
    }

    const relays = await OutboundRelaysOrchestrator.getInstance().getCombinedRelays([pubkey], true);
    if (relays.length === 0) return null;

    const dTag = this.cfg.dTagFor(key);
    try {
      const events = await NostrTransport.getInstance().fetch(relays, [{
        kinds: [NIP78_KIND],
        authors: [pubkey],
        '#d': [dTag],
        limit: 1,
      }], FETCH_TIMEOUT_MS, false, this.cfg.fetchLabel);

      if (events.length === 0) {
        this.cache.set(ck, { data: null, fetchedAt: Date.now() });
        return null;
      }

      const event = events.sort((a, b) => b.created_at - a.created_at)[0];
      if (!event) return null;

      const data = this.cfg.parse(event.content);
      this.cache.set(ck, { data, fetchedAt: Date.now() });
      return data;
    } catch (error) {
      SystemLogger.getInstance().error(this.cfg.name,
        `Failed to fetch ${dTag} for ${pubkey}: ${error}`
      );
      return null;
    }
  }

  /**
   * Sign + publish `data` under the given key. Throws on auth failure /
   * empty write-relay set / sign failure. Invalidates the cache for
   * `(currentUser, key)` so the next fetch reads the freshly-published event.
   */
  public async publish(data: T, key: string = '', diagPayload: Record<string, unknown> = {}): Promise<void> {
    const auth = AuthService.getInstance();
    const currentUser = auth.getCurrentUser();
    if (!currentUser) throw new Error('User not authenticated');

    const transport = NostrTransport.getInstance();
    const writeRelays = transport.getWriteRelays();
    if (writeRelays.length === 0) throw new Error('No write relays available');

    const dTag = this.cfg.dTagFor(key);
    const event = {
      kind: NIP78_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', dTag]],
      content: JSON.stringify(data),
      pubkey: currentUser.pubkey,
    };

    const signed = await auth.signEvent(event);
    if (!signed) throw new Error(`Failed to sign ${this.cfg.name} event`);

    await transport.publishContent(signed);
    this.invalidate(currentUser.pubkey, key);

    diagLog('lists', `${this.cfg.name} publishToRelays`, { dTag, ...diagPayload });
  }

  /**
   * NIP-09 deletion of the addressable coordinate. Marks the cache entry
   * as null so the next fetch returns null without a relay roundtrip.
   */
  public async delete(key: string = ''): Promise<void> {
    const auth = AuthService.getInstance();
    const currentUser = auth.getCurrentUser();
    if (!currentUser) throw new Error('User not authenticated');

    const dTag = this.cfg.dTagFor(key);
    const coordinate = `${NIP78_KIND}:${currentUser.pubkey}:${dTag}`;
    const ok = await DeletionService.getInstance().deleteEvents({ coordinates: [coordinate] });
    if (!ok) throw new Error('Failed to publish NIP-09 deletion event');

    this.cache.set(this.cacheKey(currentUser.pubkey, key), { data: null, fetchedAt: Date.now() });
    diagLog('lists', `${this.cfg.name} deleteFromRelays`, { coordinate });
  }

  private cacheKey(pubkey: string, key: string): string {
    return key ? `${pubkey}::${key}` : pubkey;
  }

  private ttl(): number {
    return this.cfg.cacheTtlMs ?? DEFAULT_TTL_MS;
  }
}
