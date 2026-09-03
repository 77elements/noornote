/**
 * RemoteKindVerdictService — shared base for remote verdict checks that read
 * ONE newest replaceable event per pubkey (kind 3 contact list, kind 10000
 * mute list, …) and answer a tri-state question about the current user.
 *
 * Owns the shared machinery extracted from FollowVerificationService and
 * RemoteMuteCheckService:
 *   - LRU verdict cache (30-min TTL; 'unknown' is never cached — next call
 *     retries)
 *   - NIP-65-outbox-primary relay strategy with metadata-relay safety net
 *   - newest-event-across-relays selection
 *   - timeout/error → 'unknown' mapping with warn log
 *   - cache clearing (account-scoped key `${theirPubkey}:${myPubkey}`)
 *
 * Subclasses provide the kind, a log tag, and the verdict evaluation over
 * the newest event.
 */

import type { NDKFilter, NostrEvent } from '@nostr-dev-kit/ndk';
import { NostrTransport } from './transport/NostrTransport';
import { RelayConfig } from './RelayConfig';
import { RelayListOrchestrator } from './orchestration/RelayListOrchestrator';
import { AuthService } from './AuthService';
import { SystemLogger } from './SystemLogger';
import { LRUCache, getCacheSize } from '../helpers/LRUCache';

/** Unknown reasons producible by the shared fetch phase. */
export type FetchUnknownReason =
  | 'no-write-relays'
  | 'no-event'
  | 'timeout'
  | 'error';

export interface FetchUnknown {
  status: 'unknown';
  reason: FetchUnknownReason;
}

const VERDICT_TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_WRITE_RELAYS = 6;

export abstract class RemoteKindVerdictService<TVerdict> {
  protected transport: NostrTransport;
  protected relayConfig: RelayConfig;
  protected relayListOrch: RelayListOrchestrator;
  protected authService: AuthService;
  protected systemLogger: SystemLogger;

  protected readonly cache: LRUCache<TVerdict>;

  protected constructor() {
    this.transport = NostrTransport.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.relayListOrch = RelayListOrchestrator.getInstance();
    this.authService = AuthService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.cache = new LRUCache<TVerdict>(
      getCacheSize(1000, 500, 200),
      VERDICT_TTL_MS
    );
  }

  /** The replaceable kind this service reads (3, 10000, …). */
  protected abstract get kind(): number;

  /** Log tag for fetch diagnostics. */
  protected abstract get logTag(): string;

  /**
   * Cache-first verdict resolution: consults the LRU (unless forceRefresh),
   * delegates to `perform`, and caches the result unless it is an 'unknown'
   * verdict (next call must retry).
   */
  protected async verifyCached(
    theirPubkey: string,
    myPubkey: string,
    opts: { forceRefresh?: boolean },
    perform: () => Promise<TVerdict>
  ): Promise<TVerdict> {
    const cacheKey = `${theirPubkey}:${myPubkey}`;

    if (!opts.forceRefresh) {
      const cached = this.cache.get(cacheKey);
      if (cached) return cached;
    }

    const verdict = await perform();

    // Never cache 'unknown' — next call must retry.
    const isUnknown = (verdict as { status?: string }).status === 'unknown';
    if (!isUnknown) {
      this.cache.set(cacheKey, verdict);
    }

    return verdict;
  }

  /**
   * Fetch the target's newest event of {@link kind} — outbox relays first,
   * metadata relays as wide net. Returns the newest event plus the queried
   * relay set, or an 'unknown' result for the documented failure reasons.
   */
  protected async fetchNewestKindEvent(
    theirPubkey: string,
    forceRefresh: boolean
  ): Promise<{ newest: NostrEvent; queryRelays: string[] } | FetchUnknown> {
    const writeRelays = await this.getTheirWriteRelays(theirPubkey);

    // Wider net: target's own write relays + indexer/metadata relays. The
    // target's event may live on relays outside their current kind:10002.
    const metadataRelays = this.relayConfig.getMetadataRelays();

    const queryRelays = Array.from(
      new Set([...writeRelays.slice(0, MAX_WRITE_RELAYS), ...metadataRelays])
    );

    if (queryRelays.length === 0) {
      return { status: 'unknown', reason: 'no-write-relays' };
    }

    const filters: NDKFilter[] = [
      {
        authors: [theirPubkey],
        kinds: [this.kind],
        limit: 1,
      },
    ];

    let events: NostrEvent[];
    try {
      events = await this.transport.fetch(
        queryRelays,
        filters,
        FETCH_TIMEOUT_MS,
        forceRefresh,
        this.logTag
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const reason: 'timeout' | 'error' = msg.toLowerCase().includes('timeout')
        ? 'timeout'
        : 'error';
      this.systemLogger.warn(
        this.logTag,
        `Fetch failed for ${theirPubkey.slice(0, 8)} (${reason}): ${msg}`
      );
      return { status: 'unknown', reason };
    }

    if (!events || events.length === 0) {
      return { status: 'unknown', reason: 'no-event' };
    }

    // Pick newest across all relays.
    const newest = events.reduce((a, b) =>
      (a.created_at ?? 0) >= (b.created_at ?? 0) ? a : b
    );

    return { newest, queryRelays };
  }

  private async getTheirWriteRelays(theirPubkey: string): Promise<string[]> {
    const bootstrap = this.relayConfig.getAggregatorRelays();
    const result = await this.relayListOrch.fetchRelayList(
      theirPubkey,
      bootstrap
    );
    if (!result || !result.relays.length) return [];
    return result.relays.filter(r => r.types.includes('write')).map(r => r.url);
  }

  public clearCache(): void {
    this.cache.clear();
  }

  public clearCacheForPubkey(theirPubkey: string): void {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return;
    this.cache.delete(`${theirPubkey}:${currentUser.pubkey}`);
  }
}
