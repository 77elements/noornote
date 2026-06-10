/**
 * FollowerChangeDetector — detects "who newly followed me" (new followers ONLY; unfollows are the
 * Mutual Checker's job, not this addon's).
 *
 * CORE PRINCIPLE (see docs/todos/follower-notification.md):
 *   A `#p` sweep produces CANDIDATES only. The actual yes/no is always made by the authoritative
 *   per-user check of that user's OWN newest kind:3 (their NIP-65 outbox), run 3x. Relay-coverage
 *   noise can never trigger an alert because the user's own source must confirm it.
 *
 * Two sweep modes:
 *   - FULL (seed + warm-up): pulls every follower's contact list to build a complete baseline.
 *     Silent (no notifications). One-time per account.
 *   - INCREMENTAL (live): pulls only contact lists UPDATED since the last sweep that tag me
 *     (`since` filter) — a handful of events, tiny bandwidth. New followers always publish a fresh
 *     kind:3, so this catches them. Candidates not already known → 3x-confirm → recency-gate → alert.
 *
 * Snapshot model: ACKNOWLEDGED baseline (advanced on markAsSeen, and silently during warm-up) vs
 * PENDING (latest working set). New followers are added to the working set so they aren't re-alerted.
 */

import { FollowVerificationService, type FollowVerdict } from '../../services/FollowVerificationService';
import { AuthService } from '../../services/AuthService';
import { SystemLogger } from '../../services/SystemLogger';
import { diagLog } from '../../services/DiagnosticLogger';
import { TypedEventBus } from '../../core/TypedEventBus';
import { ModuleLoader } from '../../core/ModuleLoader';
import { FollowerSnapshotStorage, type FollowerChange } from '../../lists/FollowerSnapshotStorage';
import type { ProfileModuleApi } from '../../modules/profile/contracts';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

type FollowsVerdict = Extract<FollowVerdict, { status: 'follows' }>;

export interface FollowerDetectionResult {
  newFollowers: string[];
  sweepCount: number;
  baselineCount: number;
  durationMs: number;
  isFirstCheck: boolean;
  deferredCandidates: number;
  /** Confirmed followers whose kind:3 was too old to count as "new" — absorbed silently. */
  lateDiscoveries: number;
  /** 'warmup' = silent baseline calibration (no alert); 'live' = real new-follower detection. */
  phase: 'warmup' | 'live';
  warmupComplete: boolean;
  mode: 'full' | 'incremental';
}

export class FollowerChangeDetector {
  private static instance: FollowerChangeDetector;

  /** Authoritative confirmation passes a candidate must pass unanimously. */
  private static readonly CONFIRM_PASSES = 3;
  /** Backoff between confirmation passes so they sample independent relay states. */
  private static readonly CONFIRM_BACKOFF_MS = 400;
  /** Max concurrent authoritative verifications (never mass-parallel — overloads relays). */
  private static readonly CONCURRENCY = 5;
  /** Max candidates authoritatively verified per round; the rest defer to the next round. */
  private static readonly CANDIDATE_CAP = 200;
  /** Consecutive clean (0-new) warm-up rounds required before going live (baseline must be stable). */
  private static readonly WARMUP_STABLE_ROUNDS = 2;
  /** Safety cap: go live after this many warm-up rounds even if not strictly converged. */
  private static readonly MAX_WARMUP_ROUNDS = 4;
  /** Clock-skew margin subtracted from the incremental `since` floor. */
  private static readonly SINCE_SKEW_SECONDS = 5 * 60;
  // The "new follower" recency window (days) is a user preference read from storage
  // (getRecencyDays); a confirmed follower whose kind:3 is older than that was discovered late,
  // not newly followed — absorbed silently, not alerted.

  private followVerification: FollowVerificationService;
  private auth: AuthService;
  private storage: FollowerSnapshotStorage;
  private systemLogger: SystemLogger;
  private eventBus: TypedEventBus;
  private cancelled = false;

  private constructor() {
    this.followVerification = FollowVerificationService.getInstance();
    this.auth = AuthService.getInstance();
    this.storage = FollowerSnapshotStorage.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.eventBus = TypedEventBus.getInstance();
  }

  public static getInstance(): FollowerChangeDetector {
    if (!FollowerChangeDetector.instance) {
      FollowerChangeDetector.instance = new FollowerChangeDetector();
    }
    return FollowerChangeDetector.instance;
  }

  /** Abort an in-flight detection (account switch / addon toggle-off). */
  public cancel(): void {
    this.cancelled = true;
  }

  private empty(durationMs: number, isFirstCheck: boolean): FollowerDetectionResult {
    const warmupComplete = this.storage.isWarmupComplete();
    return {
      newFollowers: [], sweepCount: 0, baselineCount: 0, durationMs, isFirstCheck,
      deferredCandidates: 0, lateDiscoveries: 0,
      phase: warmupComplete ? 'live' : 'warmup', warmupComplete,
      mode: warmupComplete ? 'incremental' : 'full'
    };
  }

  /**
   * Run one detection round.
   * - `mode: 'auto'` (default): seed + warm-up use a FULL sweep; live uses an INCREMENTAL sweep.
   * - `mode: 'full' | 'incremental'`: force a sweep mode (testing / manual checks).
   */
  public async detect(
    opts: { mode?: 'auto' | 'full' | 'incremental'; onProgress?: (checked: number, total: number) => void } = {}
  ): Promise<FollowerDetectionResult> {
    const startTime = Date.now();
    const sweepStartedS = Math.floor(startTime / 1000);
    this.cancelled = false;
    const onProgress = opts.onProgress;

    const currentUser = this.auth.getCurrentUser();
    if (!currentUser) {
      this.systemLogger.warn('FollowerChangeDetector', 'No user logged in, skipping');
      return this.empty(0, true);
    }

    const previousSnapshot = this.storage.getSnapshot();
    const warmupComplete = this.storage.isWarmupComplete();

    // Seed + warm-up must be full sweeps; live defaults to incremental.
    const requested = opts.mode ?? 'auto';
    const isLive = warmupComplete && !!previousSnapshot;
    const sweepMode: 'full' | 'incremental' =
      requested === 'incremental' ? 'incremental'
      : requested === 'full' ? 'full'
      : (isLive ? 'incremental' : 'full');

    // ── 1. Sweep (candidates only) — via the profile module API (decoupled) ──
    let candidates: string[];
    try {
      const profileApi = ModuleLoader.getInstance().getApi<ProfileModuleApi>('profile');
      if (!profileApi) throw new Error('profile module API unavailable');
      candidates = sweepMode === 'incremental'
        ? await profileApi.streamFollowerList(currentUser.pubkey, () => {}, { since: this.computeIncrementalSince() })
        // The baseline sweep (seed + warm-up) forces the full aggregator relay set: the user
        // gave informed consent when enabling the addon, so Data Saver must not silently halve
        // its coverage and make it miss followers. Incremental checks keep the reduced set.
        : await profileApi.streamFollowerList(currentUser.pubkey, () => {}, { forceFullRelays: true });
    } catch (error) {
      this.systemLogger.error('FollowerChangeDetector', `Sweep failed: ${error}`);
      diagLog('lists', 'follower-check: sweep failed', { error: String(error) });
      return this.empty(Date.now() - startTime, !previousSnapshot);
    }
    if (this.cancelled) return this.empty(Date.now() - startTime, !previousSnapshot);

    const sweepCount = new Set(candidates).size;
    diagLog('lists', 'follower-check: sweep complete', {
      mode: sweepMode, sweepCount, baselineCount: previousSnapshot?.followerPubkeys.length ?? 0,
      firstCheck: !previousSnapshot
    });

    // ── 2. Seed (first ever check): establish the baseline, never alert ──
    if (!previousSnapshot) {
      this.storage.saveSnapshot(candidates);
      this.storage.savePendingSnapshot(candidates);
      this.storage.setLastSweepAt(sweepStartedS);
      await this.storage.saveToFile();
      const durationMs = Date.now() - startTime;
      this.systemLogger.info('FollowerChangeDetector', `Seed — baseline of ${sweepCount} followers`);
      diagLog('lists', 'follower-check: seeded initial snapshot', { sweepCount, durationMs });
      return { ...this.empty(durationMs, true), sweepCount, mode: 'full' };
    }

    // Known set = latest working snapshot (pending preferred, else acknowledged). The incremental
    // `since` filter already prevents re-fetching already-known followers, but diffing against the
    // working set is the belt that makes a new follower flagged exactly once.
    const known = this.storage.getPendingSnapshot() ?? previousSnapshot.followerPubkeys;
    const knownSet = new Set(known);
    const baselineCount = previousSnapshot.followerPubkeys.length;

    // ── 3. New-follower candidates = sweep − known (NO unfollow detection) ──
    let newCandidates = candidates.filter(pk => !knownSet.has(pk));
    let deferred = 0;
    if (newCandidates.length > FollowerChangeDetector.CANDIDATE_CAP) {
      deferred = newCandidates.length - FollowerChangeDetector.CANDIDATE_CAP;
      newCandidates = newCandidates.slice(0, FollowerChangeDetector.CANDIDATE_CAP);
      diagLog('lists', 'follower-check: candidate cap hit', { cap: FollowerChangeDetector.CANDIDATE_CAP, deferred });
    }

    // ── 4. Authoritative 3x confirmation (throttled) ──
    let verified = 0;
    const tick = () => { verified++; onProgress?.(verified, newCandidates.length); };
    const confirmed = await this.confirmEach(newCandidates, tick);
    if (this.cancelled) return this.empty(Date.now() - startTime, false);

    // ── 5. Recency split: only recently-published follows count as "new"; older = late discovery ──
    const nowS = Date.now() / 1000;
    const maxAgeS = this.storage.getRecencyDays() * 24 * 60 * 60;
    const genuinelyNew: string[] = [];
    const lateDiscoveries: string[] = [];
    for (const { pubkey, verdict } of confirmed) {
      if (verdict.followedAt >= nowS - maxAgeS) genuinelyNew.push(pubkey);
      else lateDiscoveries.push(pubkey);
    }
    const confirmedAll = [...genuinelyNew, ...lateDiscoveries];

    // ── 6. Grow the working snapshot (never shrinks — unfollows aren't tracked here) ──
    const pending = [...known, ...confirmedAll];

    const durationMs = Date.now() - startTime;
    await this.storage.addHistoryEntry({
      timestamp: Date.now(), newFollowerCount: genuinelyNew.length, sweepCount, durationMs
    });
    this.storage.setLastSweepAt(sweepStartedS);

    // ── 7. Warm-up (silent) vs live (alert) ──
    if (!warmupComplete) {
      // Build a complete baseline silently. Confirmed followers found here are existing followers
      // the seed missed (coverage gaps), so they must NOT alert — just absorb until stable.
      this.storage.saveSnapshot(pending);
      this.storage.savePendingSnapshot(pending);
      const rounds = this.storage.incrementWarmupRounds();
      const cleanRounds = confirmedAll.length === 0 ? this.storage.getWarmupCleanRounds() + 1 : 0;
      this.storage.setWarmupCleanRounds(cleanRounds);
      const converged = cleanRounds >= FollowerChangeDetector.WARMUP_STABLE_ROUNDS;
      const forced = rounds >= FollowerChangeDetector.MAX_WARMUP_ROUNDS;
      if (converged || forced) this.storage.setWarmupComplete(true);
      await this.storage.saveToFile();

      this.systemLogger.info('FollowerChangeDetector',
        `Warm-up round ${rounds} (clean ${cleanRounds}/${FollowerChangeDetector.WARMUP_STABLE_ROUNDS}): ` +
        `+${confirmedAll.length} absorbed (silent), warmupComplete=${converged || forced}`);
      diagLog('lists', 'follower-check: warm-up round (silent)', {
        round: rounds, cleanRounds, absorbed: confirmedAll.length, sweepCount, baselineCount,
        converged, forced, warmupComplete: converged || forced, durationMs
      });

      return {
        newFollowers: genuinelyNew, sweepCount, baselineCount, durationMs, isFirstCheck: false,
        deferredCandidates: deferred, lateDiscoveries: lateDiscoveries.length,
        phase: 'warmup', warmupComplete: converged || forced, mode: 'full'
      };
    }

    // LIVE: only genuinely-new follows (recent kind:3) alert; late discoveries absorbed silently.
    // The acknowledged baseline advances only on markAsSeen(); here we update PENDING only.
    this.storage.savePendingSnapshot(pending);
    this.processChanges(genuinelyNew, currentUser.pubkey);
    if (genuinelyNew.length > 0) await this.storage.saveToFile(); // persist changes so a reload restores them

    this.systemLogger.info('FollowerChangeDetector',
      `Live ${sweepMode}: +${genuinelyNew.length} new (${lateDiscoveries.length} late-absorbed, ${durationMs}ms)`);
    diagLog('lists', 'follower-check: detection complete (live)', {
      mode: sweepMode, newFollowers: genuinelyNew.length, lateDiscoveries: lateDiscoveries.length,
      sweepCount, baselineCount, deferred, durationMs
    });

    return {
      newFollowers: genuinelyNew, sweepCount, baselineCount, durationMs, isFirstCheck: false,
      deferredCandidates: deferred, lateDiscoveries: lateDiscoveries.length,
      phase: 'live', warmupComplete: true, mode: sweepMode
    };
  }

  /** `since` (unix seconds) for an incremental sweep: the delta since the last sweep, but never
   *  reaching back further than the recency window (we wouldn't alert older anyway), minus skew. */
  private computeIncrementalSince(): number {
    const lastSweepAt = this.storage.getLastSweepAt();
    const recencyS = this.storage.getRecencyDays() * 24 * 60 * 60;
    const nowS = Math.floor(Date.now() / 1000);
    return Math.max(lastSweepAt, nowS - recencyS) - FollowerChangeDetector.SINCE_SKEW_SECONDS;
  }

  /**
   * For each candidate, run the authoritative `follows` check CONFIRM_PASSES times; keep it only
   * if all passes confirm. Throttled to CONCURRENCY.
   */
  private async confirmEach(
    candidates: string[],
    tick: () => void
  ): Promise<Array<{ pubkey: string; verdict: FollowsVerdict }>> {
    const confirmed: Array<{ pubkey: string; verdict: FollowsVerdict }> = [];
    const queue = [...candidates];

    const worker = async (): Promise<void> => {
      while (queue.length > 0 && !this.cancelled) {
        const pubkey = queue.shift()!;
        const verdict = await this.verifyUnanimous(pubkey);
        if (verdict) confirmed.push({ pubkey, verdict });
        tick();
      }
    };

    const workers = Array.from(
      { length: Math.min(FollowerChangeDetector.CONCURRENCY, candidates.length) },
      () => worker()
    );
    await Promise.all(workers);
    return confirmed;
  }

  /** Returns the `follows` verdict only if all CONFIRM_PASSES checks confirm it; else null. */
  private async verifyUnanimous(pubkey: string): Promise<FollowsVerdict | null> {
    let last: FollowsVerdict | null = null;
    for (let pass = 0; pass < FollowerChangeDetector.CONFIRM_PASSES; pass++) {
      if (this.cancelled) return null;
      const verdict = await this.followVerification.verifyFollowsBack(pubkey, { forceRefresh: true });
      // Any non-`follows` verdict (including 'unknown') fails the gate → candidate carried over.
      if (verdict.status !== 'follows') return null;
      last = verdict;
      if (pass < FollowerChangeDetector.CONFIRM_PASSES - 1) {
        await this.sleep(FollowerChangeDetector.CONFIRM_BACKOFF_MS);
      }
    }
    return last;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** Store new-follower changes (deduped) and inject in-app notifications (badge + Notifications tab). */
  private processChanges(newFollowers: string[], myPubkey: string): void {
    const alreadyNotified = new Set(this.storage.getChanges().map(c => c.pubkey));
    const fresh = newFollowers.filter(pk => !alreadyNotified.has(pk));
    if (fresh.length === 0) return;

    const now = Date.now();
    this.storage.addChanges(fresh.map(pubkey => ({ pubkey, type: 'new_follower' as const, detectedAt: now })));
    for (const pubkey of fresh) this.injectNotification(pubkey, myPubkey, now);

    this.eventBus.emit('follower-changes:detected', { newFollowerCount: fresh.length });
  }

  /** Emit a synthetic notification (not published) the NotificationsOrchestrator turns into a badge/tab entry. */
  private injectNotification(pubkey: string, myPubkey: string, ts: number): void {
    const syntheticEvent: NostrEvent = {
      id: `follower-new-${pubkey}-${ts}`,
      pubkey,
      kind: 99002, // synthetic kind for follower changes (mutual uses 99001)
      created_at: Math.floor(ts / 1000),
      tags: [['type', 'follower_new'], ['p', myPubkey]],
      content: '',
      sig: '',
    };
    this.eventBus.emit('follower-notification:new', { event: syntheticEvent, type: 'follower_new' });
  }

  /** Promote the pending snapshot to the acknowledged baseline and clear changes. */
  public async markAsSeen(): Promise<void> {
    const pending = this.storage.getPendingSnapshot();
    if (pending) this.storage.saveSnapshot(pending);
    this.storage.clearChanges();
    await this.storage.saveToFile();
    this.eventBus.emit('follower-changes:seen');
    this.systemLogger.info('FollowerChangeDetector', 'Changes marked as seen, baseline advanced');
  }

  public getChanges(): FollowerChange[] {
    return this.storage.getChanges();
  }

  public hasUnseenChanges(): boolean {
    return this.storage.hasUnseenChanges();
  }
}

// ── Debug console helper (mirrors the mutual-change debug hooks). Force a check, inspect state,
//    mark seen, or reset the baseline from DevTools. Loaded only with the addon. ──
if (typeof window !== 'undefined') {
  const prog = (c: number, t: number) => console.debug(`[follower-check] verified ${c}/${t}`);
  (window as any).__FOLLOWER_CHANGE_DETECTOR__ = {
    check: () => FollowerChangeDetector.getInstance().detect({ onProgress: prog }),
    full: () => FollowerChangeDetector.getInstance().detect({ mode: 'full', onProgress: prog }),
    incremental: () => FollowerChangeDetector.getInstance().detect({ mode: 'incremental', onProgress: prog }),
    state: () => {
      const s = FollowerSnapshotStorage.getInstance();
      console.debug('=== FollowerSnapshotStorage State ===');
      console.debug('Acknowledged snapshot count:', s.getSnapshot()?.followerPubkeys.length ?? null);
      console.debug('Pending snapshot count:', s.getPendingSnapshot()?.length ?? null);
      console.debug('Warm-up complete:', s.isWarmupComplete(), '| rounds:', s.getWarmupRounds());
      console.debug('Last sweep at:', s.getLastSweepAt(), '| recency days:', s.getRecencyDays());
      console.debug('Unseen changes:', s.hasUnseenChanges(), '| changes:', s.getChanges());
    },
    markSeen: () => FollowerChangeDetector.getInstance().markAsSeen(),
    reset: () => FollowerSnapshotStorage.getInstance().reset(),
  };
}
