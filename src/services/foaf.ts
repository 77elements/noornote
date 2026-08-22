/**
 * FoafService — Friend-of-a-Friend graph walker.
 *
 * Reusable, standalone module. Knows nothing about any specific feature
 * (article feeds, spam filtering, profile badges, …). Callers ask:
 *
 *   await FoafService.getInstance().getFoaf(2)  → Set<string> of degree-2 pubkeys
 *   await FoafService.getInstance().isFoaf(pubkey, 2)  → boolean
 *
 * Degrees:
 *   1 — direct follows (the user's own kind:3 p-tags, 1:1)
 *   2 — pubkeys followed by any degree-1 follow, deduplicated, excluding
 *       self and anything already in degree 1
 *   3 — pubkeys followed by any degree-2 pubkey, deduplicated across all
 *       degrees, excluding self and anything already in degrees 1–2
 *
 * The graph explosion at degree 3 is real — see caller warning in `build`.
 * Don't invoke degree 3 unless you actually need it.
 *
 * Caching:
 *   - In-memory, keyed by degree.
 *   - Cache invalidates automatically when the user's follow count changes
 *     (the only event that can meaningfully alter the graph). Also has a
 *     24h TTL fallback for safety.
 *   - Concurrent callers for the same degree share one in-flight build
 *     (de-dupe).
 *   - Mirrored to IndexedDB per account (FoafStore) — a cold start restores
 *     the last build instead of re-fetching every kind:3 from relays, under
 *     the same freshness rules (follow-count match + 24h TTL).
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import type { NDKFilter } from '@nostr-dev-kit/ndk';
import { AuthService } from './AuthService';
import { NostrTransport } from './transport/NostrTransport';
import { RelayConfig } from './RelayConfig';
import { SystemLogger } from './SystemLogger';
import { FollowCheckService } from './FollowCheckService';
import { diagLog } from './DiagnosticLogger';
import { foafStore } from './FoafStore';
import { isFoafEntryFresh } from './foafFreshness';

export type FoafDegree = 1 | 2 | 3;

interface FoafCacheEntry {
  /** Deduplicated pubkeys at this degree, excluding self and lower degrees. */
  pubkeys: string[];
  /** Snapshot of the user's follow count at build time. If the user's follow
   *  count later diverges, the cache is stale and rebuilt on next access. */
  followCountAtBuild: number;
  /** Build timestamp — used by the TTL fallback. */
  builtAt: number;
}

const FOAF_FETCH_BATCH = 50; // pubkeys per kind:3 fetch
const FOAF_FETCH_TIMEOUT_MS = 15000; // per batch

/**
 * Hard cap on how many source pubkeys we expand to the NEXT degree. Without
 * this, degree 2 from 421 follows can easily yield ~28k pubkeys, and expanding
 * all of those to degree 3 (28k kind:3 fetches) takes hours and gets the user
 * rate-limited or blocked by relays. Sampling here bounds the work and the
 * relay load: at most this many kind:3 fetches per degree transition.
 *
 * 200 sources × ~150 follows-each ≈ ~30k cap on any single degree's result —
 * matches what callers already sample down at the consumer side.
 */
const FOAF_EXPANSION_SOURCE_CAP = 200;

export class FoafService {
  private static instance: FoafService;

  private readonly transport: NostrTransport;
  private readonly relayConfig: RelayConfig;
  private readonly systemLogger: SystemLogger;
  private readonly followCheckService: FollowCheckService;
  private readonly authService: AuthService;

  /** Per-degree cache. */
  private readonly cache = new Map<FoafDegree, FoafCacheEntry>();

  /** In-flight builds — concurrent callers for the same degree share one Promise. */
  private readonly inflight = new Map<FoafDegree, Promise<string[]>>();

  public static getInstance(): FoafService {
    if (!FoafService.instance) {
      FoafService.instance = new FoafService();
    }
    return FoafService.instance;
  }

  private constructor() {
    this.transport = NostrTransport.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.followCheckService = FollowCheckService.getInstance();
    this.authService = AuthService.getInstance();
  }

  /**
   * Get the deduplicated pubkey set at the requested degree.
   * Excludes the user themselves and any pubkeys already present at lower
   * degrees (i.e. degree-2 does NOT include degree-1).
   *
   * Returns a fresh Set per call — callers may mutate freely.
   */
  public async getFoaf(degree: FoafDegree): Promise<Set<string>> {
    this.assertDegree(degree);
    const list = await this.ensure(degree);
    return new Set(list);
  }

  /**
   * Convenience: membership check at the requested degree.
   * Cheaper than `getFoaf` if the caller only needs one verdict, because the
   * Set is not materialised in the caller's scope.
   */
  public async isFoaf(pubkey: string, degree: FoafDegree): Promise<boolean> {
    this.assertDegree(degree);
    const list = await this.ensure(degree);
    // Linear scan is fine for one-off checks. For batch membership queries,
    // callers should `getFoaf` once and reuse the Set.
    return list.includes(pubkey);
  }

  /**
   * Drop the entire cache (memory + persisted). Call on logout, account
   * switch, or any other event that orphans the current user's graph.
   */
  public clearCache(): void {
    this.cache.clear();
    this.inflight.clear();
    void foafStore.clear();
    this.systemLogger.info('Foaf', 'Cache cleared');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────────────────

  private assertDegree(degree: FoafDegree): void {
    if (degree !== 1 && degree !== 2 && degree !== 3) {
      throw new Error(`FoafService: degree must be 1, 2, or 3 (got ${degree})`);
    }
  }

  /**
   * Return the cached list if fresh; otherwise build (or join an in-flight build).
   * Recursively ensures lower degrees first — they're needed to build higher
   * degrees AND to exclude lower-degree pubkeys from higher-degree results.
   */
  private async ensure(degree: FoafDegree): Promise<string[]> {
    const currentFollowCount = await this.followCheckService.getFollowCount();

    const cached = this.cache.get(degree);
    if (cached && isFoafEntryFresh(cached.followCountAtBuild, cached.builtAt, currentFollowCount)) {
      return cached.pubkeys;
    }

    // Cold start: restore the last persisted build (IndexedDB, per account)
    // under the same freshness rules before hitting any relay.
    const persisted = await foafStore.load(degree);
    if (persisted && isFoafEntryFresh(persisted.followCountAtBuild, persisted.builtAt, currentFollowCount)) {
      // Cache the restored graph with its ORIGINAL build count (not the
      // current one) so tolerance keeps measuring against the true build
      // snapshot and can't drift across sessions.
      this.cache.set(degree, persisted);
      const ageMin = Math.round((Date.now() - persisted.builtAt) / 60000);
      this.systemLogger.info(
        'Foaf',
        `Degree ${degree} restored from local cache — ${persisted.pubkeys.length} pubkeys (built ${ageMin}m ago)`
      );
      diagLog('system', `Foaf degree ${degree} restored from IndexedDB`, {
        pubkeys: persisted.pubkeys.length,
        builtAt: new Date(persisted.builtAt).toISOString(),
      });
      return persisted.pubkeys;
    }

    const inflight = this.inflight.get(degree);
    if (inflight) return inflight;

    const promise = this.build(degree).finally(() => {
      this.inflight.delete(degree);
    });
    this.inflight.set(degree, promise);
    return promise;
  }

  /**
   * Build the requested degree from scratch. Always (re)builds the lower
   * degrees first because their exclusion sets are needed.
   */
  private async build(degree: FoafDegree): Promise<string[]> {
    const t0 = Date.now();
    this.systemLogger.info('Foaf', `Building degree ${degree}...`);

    const myPubkey = this.authService.getCurrentUser()?.pubkey;
    if (!myPubkey) {
      this.systemLogger.warn('Foaf', 'No current user — cannot build graph');
      return [];
    }

    // Degree 1 — always the user's own follows.
    const degree1Set = await this.followCheckService.getFollowedPubkeys();
    degree1Set.delete(myPubkey); // exclude self just in case
    const followCountAtBuild = degree1Set.size;
    this.putCache(1, [...degree1Set], followCountAtBuild, t0);
    if (degree === 1) {
      this.logBuild(1, degree1Set.size, t0);
      return [...degree1Set];
    }

    // Degree 2 — collect p-tags from every degree-1 pubkey's kind:3.
    // Degree 1 is the user's own follows — typically small (hundreds), so we
    // expand ALL of them. Cap doesn't bite here in practice.
    const exclude2 = new Set<string>(degree1Set);
    exclude2.add(myPubkey);
    const degree2Set = await this.collectFollowees([...degree1Set], exclude2);
    this.putCache(2, [...degree2Set], followCountAtBuild, t0);
    if (degree === 2) {
      this.logBuild(2, degree2Set.size, t0);
      return [...degree2Set];
    }

    // Degree 3 — collect p-tags from degree-2's kind:3s. Degree 2 can be tens
    // of thousands of pubkeys; expanding all of them is unworkable (hours of
    // kind:3 fetches → relay rate-limits / blocks). Sample down to
    // FOAF_EXPANSION_SOURCE_CAP before expanding. The cap also bounds total
    // relay load for the whole build.
    const degree2Sample = this.sampleSources([...degree2Set], FOAF_EXPANSION_SOURCE_CAP);
    const exclude3 = new Set<string>([...degree1Set, ...degree2Set, myPubkey]);
    const degree3Set = await this.collectFollowees(degree2Sample, exclude3);
    this.putCache(3, [...degree3Set], followCountAtBuild, t0);
    this.logBuild(3, degree3Set.size, t0);
    return [...degree3Set];
  }

  /**
   * Fisher-Yates partial shuffle returning the first `cap` items. Used to
   * bound the source set expanded into the next degree — keeps relay load
   * predictable regardless of how large the prior degree grew.
   */
  private sampleSources(sources: string[], cap: number): string[] {
    if (sources.length <= cap) return sources;
    const sample = sources.slice(0, cap);
    for (let i = cap; i < sources.length; i++) {
      const j = Math.floor(Math.random() * (i + 1));
      if (j < cap) sample[j] = sources[i]!;
    }
    return sample;
  }

  /**
   * Fetch kind:3 events for every pubkey in `sources` (batched), collect their
   * p-tag targets, exclude anything in `exclude`, and return the deduplicated
   * remainder.
   *
   * NDK dedupes replaceable events per-author internally, so one fetch with
   * `authors: [...]` returns at most one (the latest) kind:3 per source pubkey.
   */
  private async collectFollowees(
    sources: string[],
    exclude: Set<string>
  ): Promise<Set<string>> {
    const result = new Set<string>();
    if (sources.length === 0) return result;

    const relays = this.relayConfig.getReadRelays();
    if (relays.length === 0) {
      this.systemLogger.warn('Foaf', 'No read relays configured');
      return result;
    }

    for (let i = 0; i < sources.length; i += FOAF_FETCH_BATCH) {
      const batch = sources.slice(i, i + FOAF_FETCH_BATCH);
      const filter: NDKFilter = { kinds: [3], authors: batch };

      let events: NostrEvent[];
      try {
        events = await this.transport.fetch(
          relays,
          [filter],
          FOAF_FETCH_TIMEOUT_MS,
          false,
          'Foaf'
        );
      } catch (err) {
        // One failed batch should not poison the whole build — relay hiccups
        // are common and the graph is best-effort.
        this.systemLogger.warn('Foaf', `Batch ${Math.floor(i / FOAF_FETCH_BATCH) + 1} failed: ${err}`);
        continue;
      }

      for (const ev of events) {
        for (const tag of ev.tags) {
          if (tag[0] === 'p' && typeof tag[1] === 'string' && !exclude.has(tag[1])) {
            result.add(tag[1]);
          }
        }
      }
    }

    return result;
  }

  private putCache(degree: FoafDegree, pubkeys: string[], followCount: number, t0: number): void {
    this.cache.set(degree, {
      pubkeys,
      followCountAtBuild: followCount,
      builtAt: t0,
    });
    // Mirror to IndexedDB (per account) so cold starts restore instead of
    // rebuilding. Fire-and-forget — see FoafStore.
    void foafStore.save(degree, { pubkeys, followCountAtBuild: followCount, builtAt: t0 });
  }

  private logBuild(degree: FoafDegree, count: number, t0: number): void {
    const dt = Date.now() - t0;
    this.systemLogger.info('Foaf', `Degree ${degree} ready — ${count} pubkeys in ${dt}ms`);
    diagLog('system', `Foaf degree ${degree} built: ${count} pubkeys in ${dt}ms`, {});
  }
}
