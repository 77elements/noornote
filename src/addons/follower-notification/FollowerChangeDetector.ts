/**
 * FollowerChangeDetector
 * Detects "who newly followed me" and "who unfollowed me" — bulletproof, zero false-positives.
 *
 * CORE PRINCIPLE (see docs/todos/follower-notification.md):
 *   The broad `#p` sweep produces CANDIDATES only. Every actual change decision is made by the
 *   authoritative per-user check of that user's OWN newest kind:3 (their NIP-65 outbox), run 3x.
 *   Relay-coverage noise can never trigger a change because the user's own source must confirm it.
 *
 * STEP 1 SCOPE: pure detection logic + snapshot persistence. NO notifications, NO UI, NO scheduler.
 * Trigger manually via the dev console hook `window.__FOLLOWER_CHANGE_DETECTOR__` (DEV only).
 *
 * Snapshot model mirrors MutualChangeDetector: ACKNOWLEDGED baseline (advanced only on markAsSeen)
 * vs PENDING (last detect()), so changes never flip-flop.
 */

import { FollowerCountService } from '../../services/FollowerCountService';
import { FollowVerificationService, type FollowVerdict } from '../../services/FollowVerificationService';
import { AuthService } from '../../services/AuthService';
import { SystemLogger } from '../../services/SystemLogger';
import { diagLog } from '../../services/DiagnosticLogger';
import { TypedEventBus } from '../../core/TypedEventBus';
import { FollowerSnapshotStorage, type FollowerChange } from '../../lists/FollowerSnapshotStorage';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

export interface FollowerDetectionResult {
  newFollowers: string[];
  lostFollowers: string[];
  sweepCount: number;
  baselineCount: number;
  durationMs: number;
  isFirstCheck: boolean;
  coverageGateFailed: boolean;
  deferredCandidates: number;
  /** Confirmed followers whose kind:3 was too old to count as "new" — absorbed silently. */
  lateDiscoveries: number;
  /** 'warmup' = silent baseline reconciliation (no notification); 'live' = real changes. */
  phase: 'warmup' | 'live';
  warmupComplete: boolean;
}

export class FollowerChangeDetector {
  private static instance: FollowerChangeDetector;

  /** Authoritative confirmation passes a candidate must pass unanimously. */
  private static readonly CONFIRM_PASSES = 3;
  /** Backoff between confirmation passes so they sample independent relay states. */
  private static readonly CONFIRM_BACKOFF_MS = 400;
  /** Max concurrent authoritative verifications (never mass-parallel — overloads relays). */
  private static readonly CONCURRENCY = 5;
  /** Discard a round if the sweep lost more than this fraction of the baseline (relay outage). */
  private static readonly COVERAGE_DROP_THRESHOLD = 0.40;
  /** Max candidates authoritatively verified per round; the rest defer to the next round. */
  private static readonly CANDIDATE_CAP = 200;
  /** Consecutive clean (0-diff) rounds required before going live (baseline must be stable). */
  private static readonly WARMUP_STABLE_ROUNDS = 2;
  /** Safety cap: go live after this many warm-up rounds even if not strictly converged. */
  private static readonly MAX_WARMUP_ROUNDS = 4;
  // The "new follower" recency window is a user preference (days), read from the snapshot
  // storage (getRecencyDays); a confirmed follower whose kind:3 (incl. us) is older than that
  // was discovered late, not newly followed — absorbed silently, not alerted.

  private followerCount: FollowerCountService;
  private followVerification: FollowVerificationService;
  private auth: AuthService;
  private storage: FollowerSnapshotStorage;
  private systemLogger: SystemLogger;
  private eventBus: TypedEventBus;
  private cancelled = false;

  private constructor() {
    this.followerCount = FollowerCountService.getInstance();
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

  private empty(durationMs: number, isFirstCheck: boolean, coverageGateFailed = false): FollowerDetectionResult {
    const warmupComplete = this.storage.isWarmupComplete();
    return {
      newFollowers: [], lostFollowers: [], sweepCount: 0, baselineCount: 0,
      durationMs, isFirstCheck, coverageGateFailed, deferredCandidates: 0, lateDiscoveries: 0,
      phase: warmupComplete ? 'live' : 'warmup', warmupComplete
    };
  }

  /**
   * Run one detection round. Does NOT advance the acknowledged baseline (only markAsSeen does).
   */
  public async detect(onProgress?: (checked: number, total: number) => void): Promise<FollowerDetectionResult> {
    const startTime = Date.now();
    this.cancelled = false;

    const currentUser = this.auth.getCurrentUser();
    if (!currentUser) {
      this.systemLogger.warn('FollowerChangeDetector', 'No user logged in, skipping');
      return this.empty(0, true);
    }

    const previousSnapshot = this.storage.getSnapshot();

    // ── 1. Discovery sweep (candidates only) ──
    let candidates: string[];
    try {
      candidates = await this.followerCount.streamFollowerList(currentUser.pubkey, () => {});
    } catch (error) {
      this.systemLogger.error('FollowerChangeDetector', `Sweep failed: ${error}`);
      diagLog('lists', 'follower-check: sweep failed', { error: String(error) });
      return this.empty(Date.now() - startTime, !previousSnapshot);
    }
    if (this.cancelled) return this.empty(Date.now() - startTime, !previousSnapshot);

    const candidateSet = new Set(candidates);
    const sweepCount = candidateSet.size;

    diagLog('lists', 'follower-check: sweep complete', {
      sweepCount, baselineCount: previousSnapshot?.followerPubkeys.length ?? 0,
      firstCheck: !previousSnapshot
    });

    // ── 2. First check: seed baseline, never notify ──
    // A raw (possibly slightly dirty) baseline is safe: every future change is re-confirmed
    // per-user, so a phantom seed entry can never become a false unfollow notification.
    if (!previousSnapshot) {
      this.storage.saveSnapshot(candidates);
      this.storage.savePendingSnapshot(candidates);
      await this.storage.saveToFile();
      const durationMs = Date.now() - startTime;
      this.systemLogger.info('FollowerChangeDetector', `First check — seeded ${sweepCount} followers`);
      diagLog('lists', 'follower-check: seeded initial snapshot', { sweepCount, durationMs });
      return { ...this.empty(durationMs, true), sweepCount };
    }

    const baseline = previousSnapshot.followerPubkeys;
    const baselineSet = new Set(baseline);
    const baselineCount = baseline.length;

    // ── 3. Coverage gate: reject globally-degraded rounds (relay outage, not real unfollows) ──
    const minAcceptable = Math.floor(baselineCount * (1 - FollowerChangeDetector.COVERAGE_DROP_THRESHOLD));
    if (baselineCount > 0 && sweepCount < minAcceptable) {
      const durationMs = Date.now() - startTime;
      this.systemLogger.warn('FollowerChangeDetector',
        `Coverage gate: sweep ${sweepCount} < ${minAcceptable} (baseline ${baselineCount}) — discarding round`);
      diagLog('lists', 'follower-check: coverage gate failed (round discarded)', {
        sweepCount, baselineCount, minAcceptable
      });
      return this.empty(durationMs, false, true);
    }

    // ── 4. Delta (candidates) ──
    let newCandidates = candidates.filter(pk => !baselineSet.has(pk));
    let lostCandidates = baseline.filter(pk => !candidateSet.has(pk));

    // Cap per-round verification budget; defer overflow to the next round.
    let deferred = 0;
    const cap = FollowerChangeDetector.CANDIDATE_CAP;
    if (newCandidates.length + lostCandidates.length > cap) {
      const keepNew = Math.min(newCandidates.length, cap);
      const keepLost = Math.max(0, cap - keepNew);
      deferred = (newCandidates.length - keepNew) + (lostCandidates.length - keepLost);
      newCandidates = newCandidates.slice(0, keepNew);
      lostCandidates = lostCandidates.slice(0, keepLost);
      diagLog('lists', 'follower-check: candidate cap hit', { cap, deferred });
    }

    // ── 5. Authoritative 3x confirmation (throttled) ──
    const totalToVerify = newCandidates.length + lostCandidates.length;
    let verified = 0;
    const tick = () => { verified++; onProgress?.(verified, totalToVerify); };

    const confirmedNewVerdicts = await this.confirmEach(newCandidates, 'follows', tick);
    if (this.cancelled) return this.empty(Date.now() - startTime, false);
    const confirmedLostVerdicts = await this.confirmEach(lostCandidates, 'does-not-follow', tick);
    if (this.cancelled) return this.empty(Date.now() - startTime, false);

    const confirmedLost = confirmedLostVerdicts.map(v => v.pubkey);

    // Recency split: a confirmed follower whose contact list (including us) is OLD was not a NEW
    // follow — our sweep just discovered a long-standing follower late. Absorb them into the
    // baseline silently; only recently-published follows generate a notification. (kind:3
    // created_at is the best signal available; Nostr records no "started following" timestamp.)
    const nowS = Date.now() / 1000;
    const maxAgeS = this.storage.getRecencyDays() * 24 * 60 * 60;
    const genuinelyNew: string[] = [];
    const lateDiscoveries: string[] = [];
    for (const { pubkey, verdict } of confirmedNewVerdicts) {
      const followedAt = verdict.status === 'follows' ? verdict.followedAt : 0;
      if (followedAt >= nowS - maxAgeS) genuinelyNew.push(pubkey);
      else lateDiscoveries.push(pubkey);
    }
    const confirmedNewAll = [...genuinelyNew, ...lateDiscoveries];

    // ── 6. Build pending snapshot conservatively ──
    // Carry over everything except confirmed unfollows; add ALL confirmed followers (new + late)
    // so a late discovery isn't re-flagged next round. Unconfirmed candidates are carried over.
    const confirmedLostSet = new Set(confirmedLost);
    const pending = baseline.filter(pk => !confirmedLostSet.has(pk));
    for (const pk of confirmedNewAll) pending.push(pk);

    // ── 7. Warm-up reconciliation vs live ──
    const durationMs = Date.now() - startTime;
    const confirmedCount = confirmedNewAll.length + confirmedLost.length;
    await this.storage.addHistoryEntry({
      timestamp: Date.now(),
      newFollowerCount: genuinelyNew.length,
      lostFollowerCount: confirmedLost.length,
      sweepCount,
      durationMs,
    });

    if (!this.storage.isWarmupComplete()) {
      // WARM-UP: the seeded baseline is not yet authoritative. Confirmed diffs here are mostly
      // seed artifacts (real followers the seed sweep missed, or stale seed includes). Apply
      // them SILENTLY to the acknowledged baseline — no changes stored, no notification — until
      // a round reconciles cleanly (0 confirmed) or the cap is hit.
      this.storage.saveSnapshot(pending);
      this.storage.savePendingSnapshot(pending);
      const rounds = this.storage.incrementWarmupRounds();
      // Require WARMUP_STABLE_ROUNDS consecutive clean rounds so two sweeps coincidentally
      // missing the same followers can't converge prematurely. A dirty round resets the streak.
      const cleanRounds = confirmedCount === 0 ? this.storage.getWarmupCleanRounds() + 1 : 0;
      this.storage.setWarmupCleanRounds(cleanRounds);
      const converged = cleanRounds >= FollowerChangeDetector.WARMUP_STABLE_ROUNDS;
      const forced = rounds >= FollowerChangeDetector.MAX_WARMUP_ROUNDS;
      if (converged || forced) this.storage.setWarmupComplete(true);
      await this.storage.saveToFile();

      this.systemLogger.info('FollowerChangeDetector',
        `Warm-up round ${rounds} (clean streak ${cleanRounds}/${FollowerChangeDetector.WARMUP_STABLE_ROUNDS}): ` +
        `reconciled +${confirmedNewAll.length}/-${confirmedLost.length} (silent), warmupComplete=${converged || forced}`);
      diagLog('lists', 'follower-check: warm-up round (silent reconciliation)', {
        round: rounds, cleanRounds, reconciledNew: confirmedNewAll.length, reconciledLost: confirmedLost.length,
        sweepCount, baselineCount, converged, forced, warmupComplete: converged || forced, durationMs
      });

      return {
        newFollowers: genuinelyNew, lostFollowers: confirmedLost,
        sweepCount, baselineCount, durationMs, isFirstCheck: false,
        coverageGateFailed: false, deferredCandidates: deferred, lateDiscoveries: lateDiscoveries.length,
        phase: 'warmup', warmupComplete: converged || forced
      };
    }

    // LIVE: only genuinely-new follows (recent kind:3) notify; late discoveries are absorbed
    // silently into the baseline. The acknowledged baseline advances only on markAsSeen().
    this.storage.savePendingSnapshot(pending);
    this.processChanges(genuinelyNew, confirmedLost, currentUser.pubkey);

    // Persist the stored changes to the file too (desktop) so a reload restores the
    // notifications. Writes the unchanged acknowledged snapshot + the new changes — the
    // baseline is NOT advanced here (that only happens on markAsSeen).
    if (genuinelyNew.length > 0 || confirmedLost.length > 0) {
      await this.storage.saveToFile();
    }

    this.systemLogger.info('FollowerChangeDetector',
      `Live: +${genuinelyNew.length} new (${lateDiscoveries.length} late-absorbed), -${confirmedLost.length} lost (${durationMs}ms)`);
    diagLog('lists', 'follower-check: detection complete (live)', {
      newFollowers: genuinelyNew.length, lateDiscoveries: lateDiscoveries.length,
      lostFollowers: confirmedLost.length, sweepCount, baselineCount, deferred, durationMs
    });

    return {
      newFollowers: genuinelyNew, lostFollowers: confirmedLost,
      sweepCount, baselineCount, durationMs, isFirstCheck: false,
      coverageGateFailed: false, deferredCandidates: deferred, lateDiscoveries: lateDiscoveries.length,
      phase: 'live', warmupComplete: true
    };
  }

  /**
   * For each candidate, run the authoritative check CONFIRM_PASSES times; keep it only if all
   * passes agree on `expected` (a definitive verdict). Throttled to CONCURRENCY.
   */
  private async confirmEach(
    candidates: string[],
    expected: 'follows' | 'does-not-follow',
    tick: () => void
  ): Promise<Array<{ pubkey: string; verdict: FollowVerdict }>> {
    const confirmed: Array<{ pubkey: string; verdict: FollowVerdict }> = [];
    const queue = [...candidates];

    const worker = async (): Promise<void> => {
      while (queue.length > 0 && !this.cancelled) {
        const pubkey = queue.shift()!;
        const verdict = await this.verifyUnanimous(pubkey, expected);
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

  /** Returns the matching verdict only if all CONFIRM_PASSES checks agree on `expected`; else null. */
  private async verifyUnanimous(pubkey: string, expected: FollowVerdict['status']): Promise<FollowVerdict | null> {
    let last: FollowVerdict | null = null;
    for (let pass = 0; pass < FollowerChangeDetector.CONFIRM_PASSES; pass++) {
      if (this.cancelled) return null;
      const verdict = await this.followVerification.verifyFollowsBack(pubkey, { forceRefresh: true });
      // Any non-matching verdict (including 'unknown') fails the gate → candidate carried over.
      if (verdict.status !== expected) return null;
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

  /** Store confirmed changes and inject in-app notifications (badge + Notifications tab). */
  private processChanges(newFollowers: string[], lostFollowers: string[], myPubkey: string): void {
    const now = Date.now();
    const changes: FollowerChange[] = [
      ...newFollowers.map(pubkey => ({ pubkey, type: 'new_follower' as const, detectedAt: now })),
      ...lostFollowers.map(pubkey => ({ pubkey, type: 'lost_follower' as const, detectedAt: now })),
    ];
    if (changes.length === 0) return;

    this.storage.addChanges(changes);
    for (const pubkey of newFollowers) this.injectNotification(pubkey, 'follower_new', myPubkey, now);
    for (const pubkey of lostFollowers) this.injectNotification(pubkey, 'follower_lost', myPubkey, now);

    this.eventBus.emit('follower-changes:detected', {
      newFollowerCount: newFollowers.length,
      lostFollowerCount: lostFollowers.length,
    });
  }

  /** Emit a synthetic notification (not published) the NotificationsOrchestrator turns into a badge/tab entry. */
  private injectNotification(pubkey: string, type: 'follower_new' | 'follower_lost', myPubkey: string, ts: number): void {
    const syntheticEvent: NostrEvent = {
      id: `follower-${type}-${pubkey}-${ts}`,
      pubkey,
      kind: 99002, // synthetic kind for follower changes (mutual uses 99001)
      created_at: Math.floor(ts / 1000),
      tags: [['type', type], ['p', myPubkey]],
      content: '',
      sig: '',
    };
    this.eventBus.emit('follower-notification:new', { event: syntheticEvent, type });
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

// ── Debug console helper (mirrors the mutual-change debug hooks). Lets you force a check,
//    inspect state, mark seen, or reset the baseline from DevTools. Loaded only with the addon. ──
if (typeof window !== 'undefined') {
  (window as any).__FOLLOWER_CHANGE_DETECTOR__ = {
    check: () => FollowerChangeDetector.getInstance().detect(
      (c, t) => console.debug(`[follower-check] verified ${c}/${t}`)
    ),
    state: () => {
      const s = FollowerSnapshotStorage.getInstance();
      console.log('=== FollowerSnapshotStorage State ===');
      console.log('Acknowledged snapshot count:', s.getSnapshot()?.followerPubkeys.length ?? null);
      console.log('Pending snapshot count:', s.getPendingSnapshot()?.length ?? null);
      console.log('Warm-up complete:', s.isWarmupComplete(), '| rounds:', s.getWarmupRounds());
      console.log('Last check:', s.getLastCheckTimestamp());
      console.log('Unseen changes:', s.hasUnseenChanges());
      console.log('Changes:', s.getChanges());
    },
    markSeen: () => FollowerChangeDetector.getInstance().markAsSeen(),
    reset: () => FollowerSnapshotStorage.getInstance().reset(),
  };
}
