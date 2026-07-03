/**
 * RemoteMuteCheckService
 *
 * Single source of truth for "has user X PUBLICLY muted the current user?"
 * Read-only sibling of FollowVerificationService — mirrors its relay strategy
 * and caching, but reads NIP-51 kind:10000 (mute list) instead of kind:3.
 *
 * Scope & privacy:
 *   - PUBLIC mutes only. A kind:10000 carries public entries as plaintext `p`
 *     tags and private entries NIP-04/44-encrypted in `.content`. The private
 *     part is only decryptable by its owner, so a remote observer can never
 *     read it — by design. We therefore only ever detect a public mute.
 *   - Verdict is tri-state: 'muted' / 'not-muted' / 'unknown'. A missing
 *     kind:10000 is 'unknown', NEVER 'not-muted' — we simply don't know.
 *   - This service NEVER touches the list-sync layer (src/lists/*). It is a
 *     pure relay read; it does not read, write or migrate the user's own lists.
 *
 * Consumers render a badge only on the definitive 'muted' verdict; 'not-muted'
 * and 'unknown' both collapse to "no badge".
 */

import type { NDKFilter, NostrEvent } from '@nostr-dev-kit/ndk';
import { NostrTransport } from './transport/NostrTransport';
import { RelayConfig } from './RelayConfig';
import { RelayListOrchestrator } from './orchestration/RelayListOrchestrator';
import { AuthService } from './AuthService';
import { SystemLogger } from './SystemLogger';
import { diagLog } from './DiagnosticLogger';
import { LRUCache, getCacheSize } from '../helpers/LRUCache';

export type MuteVerdict =
  | { status: 'muted';     verifiedAt: number; viaRelays: string[] }
  | { status: 'not-muted'; verifiedAt: number; viaRelays: string[] }
  | { status: 'unknown';   reason: 'no-write-relays' | 'no-event' | 'timeout' | 'error' };

const KIND_MUTE_LIST = 10000;
const VERDICT_TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_WRITE_RELAYS = 6;

export class RemoteMuteCheckService {
  private static instance: RemoteMuteCheckService;
  private transport: NostrTransport;
  private relayConfig: RelayConfig;
  private relayListOrch: RelayListOrchestrator;
  private authService: AuthService;
  private systemLogger: SystemLogger;

  private cache: LRUCache<MuteVerdict> = new LRUCache<MuteVerdict>(
    getCacheSize(1000, 500, 200),
    VERDICT_TTL_MS
  );

  private constructor() {
    this.transport = NostrTransport.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.relayListOrch = RelayListOrchestrator.getInstance();
    this.authService = AuthService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
  }

  public static getInstance(): RemoteMuteCheckService {
    if (!RemoteMuteCheckService.instance) {
      RemoteMuteCheckService.instance = new RemoteMuteCheckService();
    }
    return RemoteMuteCheckService.instance;
  }

  /**
   * Has `theirPubkey` publicly muted the current user?
   * Tri-state — see MuteVerdict.
   */
  public async verifyMutedByThem(
    theirPubkey: string,
    opts: { forceRefresh?: boolean } = {}
  ): Promise<MuteVerdict> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      return { status: 'unknown', reason: 'error' };
    }

    const cacheKey = `${theirPubkey}:${currentUser.pubkey}`;

    if (!opts.forceRefresh) {
      const cached = this.cache.get(cacheKey);
      if (cached) return cached;
    }

    const verdict = await this.performCheck(
      theirPubkey,
      currentUser.pubkey,
      opts.forceRefresh ?? false
    );

    // Never cache 'unknown' — next call must retry.
    if (verdict.status !== 'unknown') {
      this.cache.set(cacheKey, verdict);
    }

    return verdict;
  }

  /**
   * Boolean wrapper for UI where 'unknown'/'not-muted' both collapse to
   * "no badge".
   */
  public async mutedByThemSimple(
    theirPubkey: string,
    opts?: { forceRefresh?: boolean }
  ): Promise<boolean> {
    const verdict = await this.verifyMutedByThem(theirPubkey, opts);
    return verdict.status === 'muted';
  }

  public clearCache(): void {
    this.cache.clear();
  }

  public clearCacheForPubkey(theirPubkey: string): void {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return;
    this.cache.delete(`${theirPubkey}:${currentUser.pubkey}`);
  }

  private async performCheck(
    theirPubkey: string,
    myPubkey: string,
    forceRefresh: boolean
  ): Promise<MuteVerdict> {
    const writeRelays = await this.getTheirWriteRelays(theirPubkey);

    // Wider net: target's own write relays + indexer relays. The target's
    // kind:10000 may live on relays outside their current kind:10002.
    const metadataRelays = this.relayConfig.getMetadataRelays();

    const queryRelays = Array.from(new Set([
      ...writeRelays.slice(0, MAX_WRITE_RELAYS),
      ...metadataRelays
    ]));

    if (queryRelays.length === 0) {
      return { status: 'unknown', reason: 'no-write-relays' };
    }

    const filters: NDKFilter[] = [{
      authors: [theirPubkey],
      kinds: [KIND_MUTE_LIST],
      limit: 1
    }];

    let events: NostrEvent[];
    try {
      events = await this.transport.fetch(
        queryRelays,
        filters,
        FETCH_TIMEOUT_MS,
        forceRefresh,
        'RemoteMuteCheck'
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const reason: 'timeout' | 'error' = msg.toLowerCase().includes('timeout') ? 'timeout' : 'error';
      this.systemLogger.warn(
        'RemoteMuteCheck',
        `Fetch failed for ${theirPubkey.slice(0, 8)} (${reason}): ${msg}`
      );
      return { status: 'unknown', reason };
    }

    if (!events || events.length === 0) {
      return { status: 'unknown', reason: 'no-event' };
    }

    // Newest across all relays.
    const newest = events.reduce((a, b) =>
      (a.created_at ?? 0) >= (b.created_at ?? 0) ? a : b
    );

    // Public mutes only — plaintext `p` tags. The encrypted `.content` block
    // (private mutes) is intentionally not touched; it isn't ours to decrypt.
    const mutesMe = newest.tags.some(
      tag => tag[0] === 'p' && tag[1] === myPubkey
    );

    if (mutesMe) {
      diagLog('system', 'Remote public mute detected', {
        target: theirPubkey.slice(0, 8),
        viaRelays: queryRelays.length
      });
      return { status: 'muted', verifiedAt: Date.now(), viaRelays: queryRelays };
    }

    return { status: 'not-muted', verifiedAt: Date.now(), viaRelays: queryRelays };
  }

  private async getTheirWriteRelays(theirPubkey: string): Promise<string[]> {
    const bootstrap = this.relayConfig.getAggregatorRelays();
    const result = await this.relayListOrch.fetchRelayList(theirPubkey, bootstrap);
    if (!result || !result.relays.length) return [];
    return result.relays
      .filter(r => r.types.includes('write'))
      .map(r => r.url);
  }
}
