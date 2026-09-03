/**
 * FollowVerificationService
 *
 * Single source of truth for "does user X follow user Y?" (typically: the
 * current user). Used by ProfileView "Follows you" badge AND by
 * MutualChangeDetector "Check for changes". Both call this — never their
 * own ad-hoc kind:3 query.
 *
 * Bulletproof rules:
 *   1. Tri-state verdict: 'follows' / 'does-not-follow' / 'unknown'.
 *      A missing kind:3 event is NEVER 'does-not-follow'. That ambiguity
 *      was the root cause of the recurring "stopped following you back"
 *      false positives.
 *   2. NIP-65 outbox primary: query the target's own write relays first,
 *      with aggregator + indexer relays as a wide safety net. The
 *      target's kind:3 may live on relays they no longer list in their
 *      current kind:10002.
 *   3. Stale-snapshot guard: if the newest kind:3 we found is older than
 *      STALE_DAYS, we treat a negative finding as 'unknown' rather than
 *      'does-not-follow'. Real active follow-backs come with recent
 *      kind:3 updates; a year-old snapshot most likely predates the
 *      current relationship.
 *   4. Definitive verdicts are cached (30 min); 'unknown' is never cached
 *      so the next call retries.
 *
 * Consumers must treat 'unknown' as "carry over previous state, do NOT
 * generate an unfollow notification".
 */

import { RemoteKindVerdictService } from './RemoteKindVerdictService';

export type FollowVerdict =
  | {
      status: 'follows';
      verifiedAt: number;
      viaRelays: string[];
      theirFollowCount: number;
      followedAt: number;
    }
  | {
      status: 'does-not-follow';
      verifiedAt: number;
      viaRelays: string[];
      theirFollowCount: number;
    }
  | {
      status: 'unknown';
      reason: 'no-write-relays' | 'no-event' | 'timeout' | 'error' | 'stale';
    };

/**
 * The mutual-relationship state of a followed user, derived from a
 * {@link FollowVerdict}. This is the canonical tri-state the whole app should
 * consume for "does this user follow me back?" rendering — see
 * {@link FollowVerificationService.verifyFollowsBackBatch}. Kept distinct from
 * a plain boolean so a transient `unknown` is never collapsed into a sticky
 * false ("Not following back").
 */
export type MutualState = FollowVerdict['status'];

const STALE_DAYS = 90;

export class FollowVerificationService extends RemoteKindVerdictService<FollowVerdict> {
  private static instance: FollowVerificationService;

  private constructor() {
    super();
  }

  protected get kind(): number {
    return 3;
  }

  protected get logTag(): string {
    return 'FollowVerification';
  }

  public static getInstance(): FollowVerificationService {
    if (!FollowVerificationService.instance) {
      FollowVerificationService.instance = new FollowVerificationService();
    }
    return FollowVerificationService.instance;
  }

  /**
   * Does `theirPubkey` follow the current user?
   * Tri-state — see FollowVerdict.
   */
  public async verifyFollowsBack(
    theirPubkey: string,
    opts: { forceRefresh?: boolean } = {}
  ): Promise<FollowVerdict> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      return { status: 'unknown', reason: 'error' };
    }

    return this.verifyCached(theirPubkey, currentUser.pubkey, opts, () =>
      this.performVerification(
        theirPubkey,
        currentUser.pubkey,
        opts.forceRefresh ?? false
      )
    );
  }

  /**
   * Boolean wrapper for UI list rendering where 'unknown' must collapse to
   * "no badge" (same outcome as 'does-not-follow' visually).
   */
  public async followsBackSimple(
    theirPubkey: string,
    opts?: { forceRefresh?: boolean }
  ): Promise<boolean> {
    const verdict = await this.verifyFollowsBack(theirPubkey, opts);
    return verdict.status === 'follows';
  }

  /**
   * Verify "does each of these users follow me back?" for a batch, returning a
   * tri-state {@link FollowVerdict} per pubkey.
   *
   * Throttled (default 5 concurrent) to avoid relay overload — firing a whole
   * follow list in parallel causes timeouts, which inflate the count of
   * 'unknown' verdicts (the false-negative source). Reuses the same per-user
   * cache as {@link verifyFollowsBack} (30-min TTL; 'unknown' is never cached,
   * so unknowns auto-retry on the next call).
   *
   * This is the single batch entry point for "who follows me back?" — consumed
   * by the Extended Follows list badge and the "Check for changes" detector, so
   * both share one canonical, self-expiring source instead of diverging.
   *
   * @returns Map<theirPubkey, FollowVerdict>
   */
  public async verifyFollowsBackBatch(
    pubkeys: string[],
    opts: {
      forceRefresh?: boolean;
      onProgress?: (checked: number, total: number) => void;
      concurrency?: number;
    } = {}
  ): Promise<Map<string, FollowVerdict>> {
    const concurrency = Math.max(1, opts.concurrency ?? 5);
    const results = new Map<string, FollowVerdict>();
    const total = pubkeys.length;
    let checked = 0;
    for (let i = 0; i < pubkeys.length; i += concurrency) {
      const chunk = pubkeys.slice(i, i + concurrency);
      const settled = await Promise.all(
        chunk.map(
          async (pk): Promise<[string, FollowVerdict]> => [
            pk,
            await this.verifyFollowsBack(
              pk,
              opts.forceRefresh ? { forceRefresh: true } : {}
            ),
          ]
        )
      );
      for (const [pk, verdict] of settled) {
        results.set(pk, verdict);
      }
      checked += chunk.length;
      opts.onProgress?.(checked, total);
    }
    return results;
  }

  private async performVerification(
    theirPubkey: string,
    myPubkey: string,
    forceRefresh: boolean
  ): Promise<FollowVerdict> {
    const fetched = await this.fetchNewestKindEvent(theirPubkey, forceRefresh);

    // Fetch-phase failure: the shared unknown result is shape-compatible
    // with FollowVerdict's unknown variant.
    if ('status' in fetched) return fetched as FollowVerdict;

    const { newest, queryRelays } = fetched;
    void forceRefresh;

    const pTags = newest.tags.filter(
      (tag): tag is [string, string, ...string[]] =>
        tag[0] === 'p' && typeof tag[1] === 'string'
    );

    const followsMe = pTags.some(tag => tag[1] === myPubkey);

    if (followsMe) {
      return {
        status: 'follows',
        verifiedAt: Date.now(),
        viaRelays: queryRelays,
        theirFollowCount: pTags.length,
        // created_at of the newest kind:3 that includes us — i.e. when they last published a
        // contact list containing us. Used to suppress "new follower" alerts for long-standing
        // followers our sweep only just discovered (not actually new). Best-available signal:
        // it's "last list update", not "started following", which Nostr doesn't record.
        followedAt: newest.created_at ?? 0,
      };
    }

    // Stale-snapshot guard: a kind:3 older than STALE_DAYS is unreliable
    // as proof of non-following. The target's current kind:3 likely lives
    // on relays outside both NIP-65 and our index list.
    const newestTs = newest.created_at ?? 0;
    const ageDays = (Date.now() / 1000 - newestTs) / 86400;
    if (ageDays > STALE_DAYS) {
      this.systemLogger.info(
        this.logTag,
        `Stale verdict ignored for ${theirPubkey.slice(0, 8)}: newest kind:3 is ${Math.round(ageDays)} days old`
      );
      return { status: 'unknown', reason: 'stale' };
    }

    return {
      status: 'does-not-follow',
      verifiedAt: Date.now(),
      viaRelays: queryRelays,
      theirFollowCount: pTags.length,
    };
  }
}
