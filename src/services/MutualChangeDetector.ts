/**
 * MutualChangeDetector
 * Compares mutual snapshots and detects changes (Phase 2-4)
 *
 * ARCHITECTURE:
 * - Snapshot = "acknowledged" state (only updated on "Mark as seen")
 * - Pending snapshot = current state from last detect()
 * - Changes persist until user clicks "Mark as seen"
 * - Notifications are restored from changes on app start
 *
 * @purpose Detect unfollows and new mutuals by comparing snapshots
 * @used-by MutualChangeScheduler, FollowListSecondaryManager
 */

import { MutualService } from './MutualService';
import { FollowVerificationService } from './FollowVerificationService';
import { MutualChangeStorage, type MutualChange } from '../lists/MutualChangeStorage';
import { MutualCheckDebugLog } from '../lists/MutualCheckDebugLog';
import { TypedEventBus } from '../core/TypedEventBus';
import { SystemLogger } from './SystemLogger';
import { AuthService } from './AuthService';
import type { NostrEvent } from '@nostr-dev-kit/ndk';

export interface DetectionResult {
  unfollows: string[];
  newMutuals: string[];
  totalChanges: number;
  durationMs: number;
  isFirstCheck: boolean;
}

export class MutualChangeDetector {
  private static instance: MutualChangeDetector;
  private mutualService: MutualService;
  private followVerification: FollowVerificationService;
  private storage: MutualChangeStorage;
  private debugLog: MutualCheckDebugLog;
  private eventBus: TypedEventBus;
  private systemLogger: SystemLogger;
  private authService: AuthService;

  private constructor() {
    this.mutualService = MutualService.getInstance();
    this.followVerification = FollowVerificationService.getInstance();
    this.storage = MutualChangeStorage.getInstance();
    this.debugLog = MutualCheckDebugLog.getInstance();
    this.eventBus = TypedEventBus.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.authService = AuthService.getInstance();
  }

  public static getInstance(): MutualChangeDetector {
    if (!MutualChangeDetector.instance) {
      MutualChangeDetector.instance = new MutualChangeDetector();
    }
    return MutualChangeDetector.instance;
  }

  /**
   * Restore notifications from stored changes (called on app start)
   * This ensures notifications persist across app restarts
   */
  public async restoreNotificationsFromChanges(): Promise<void> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return;

    const changes = this.storage.getChanges();
    if (changes.length === 0) {
      this.systemLogger.info('MutualChangeDetector', 'No stored changes to restore');
      return;
    }

    this.systemLogger.info('MutualChangeDetector', `Restoring ${changes.length} notifications from stored changes`);

    // Inject notifications for all stored changes
    for (const change of changes) {
      const type = change.type === 'unfollow' ? 'mutual_unfollow' : 'mutual_new';
      await this.injectNotification(change.pubkey, type, currentUser.pubkey, change.detectedAt);
    }

    // Update green dot
    if (changes.length > 0) {
      this.storage.setUnseenChanges(true);
      this.eventBus.emit('mutual-changes:detected', {
        unfollowCount: changes.filter(c => c.type === 'unfollow').length,
        newMutualCount: changes.filter(c => c.type === 'new_mutual').length
      });
    }
  }

  /**
   * Perform detection: compare current mutuals with snapshot
   * NOTE: Snapshot is NOT updated here - only on markAsSeen()
   * @returns Detection result with unfollows, new mutuals, and timing
   */
  public async detect(onProgress?: (checked: number, total: number) => void): Promise<DetectionResult> {
    const startTime = Date.now();
    const currentUser = this.authService.getCurrentUser();

    // Start debug logging session
    this.debugLog.startCheck();

    if (!currentUser) {
      this.systemLogger.warn('MutualChangeDetector', 'No user logged in, skipping detection');
      await this.debugLog.logError('No user logged in');
      return { unfollows: [], newMutuals: [], totalChanges: 0, durationMs: 0, isFirstCheck: true };
    }

    this.systemLogger.info('MutualChangeDetector', 'Starting mutual change detection...');

    try {
      // Step 1: Get previous snapshot FIRST (for logging)
      const previousSnapshot = this.storage.getSnapshot();
      const previousMutualCount = previousSnapshot?.mutualPubkeys.length || 0;
      const previousMutualPubkeys = previousSnapshot?.mutualPubkeys || [];

      // Step 2: Get current mutuals from MutualService
      const fetchStartTime = Date.now();
      const follows = await this.mutualService.getFollowsForMutualCheck();

      // Debug: Log check start with full snapshot details
      await this.debugLog.logCheckStart(
        previousMutualCount,
        follows.length,
        previousMutualPubkeys,
        previousSnapshot?.timestamp
      );

      const followsWithStatus = await this.mutualService.checkMutualStatusBatch(follows, onProgress);
      const fetchDurationMs = Date.now() - fetchStartTime;

      const currentMutualPubkeys = followsWithStatus
        .filter(f => f.isMutual)
        .map(f => f.pubkey);

      const nonMutualCount = followsWithStatus.filter(f => !f.isMutual).length;

      this.systemLogger.info('MutualChangeDetector', `Current mutuals: ${currentMutualPubkeys.length}`);

      // Debug: Log relay fetch results with full pubkey list
      await this.debugLog.logRelayFetch(
        follows.length,
        currentMutualPubkeys.length,
        nonMutualCount,
        fetchDurationMs,
        currentMutualPubkeys
      );

      // First check: no previous snapshot - save initial and return
      if (!previousSnapshot) {
        this.systemLogger.info('MutualChangeDetector', 'First check - saving initial snapshot');
        this.storage.saveSnapshot(currentMutualPubkeys);
        this.storage.savePendingSnapshot(currentMutualPubkeys);
        await this.storage.saveToFile();

        const durationMs = Date.now() - startTime;

        // Debug: Log first check complete
        await this.debugLog.logCheckComplete([], [], durationMs, currentMutualPubkeys.length);
        await this.debugLog.logSnapshotUpdate(0, currentMutualPubkeys.length, currentMutualPubkeys, []);

        return { unfollows: [], newMutuals: [], totalChanges: 0, durationMs, isFirstCheck: true };
      }

      // Step 3: Compare with ACKNOWLEDGED snapshot (not pending)
      const previousMutuals = new Set(previousSnapshot.mutualPubkeys);
      const currentMutuals = new Set(currentMutualPubkeys);

      // Unfollows: in previous but NOT in current
      const potentialUnfollows = previousSnapshot.mutualPubkeys.filter(
        pubkey => !currentMutuals.has(pubkey)
      );

      // DOUBLE-CHECK with tri-state verdict (NIP-65 outbox-aware).
      // Only 'does-not-follow' becomes a real unfollow; 'follows' and
      // 'unknown' are re-added to the snapshot so they aren't flagged
      // on the next check either.
      const unfollows: string[] = [];
      let skippedUnknown = 0;
      let preventedFalsePositive = 0;
      if (potentialUnfollows.length > 0) {
        for (const pubkey of potentialUnfollows) {
          const verdict = await this.followVerification.verifyFollowsBack(
            pubkey,
            { forceRefresh: true }
          );
          if (verdict.status === 'does-not-follow') {
            unfollows.push(pubkey);
          } else if (verdict.status === 'follows') {
            preventedFalsePositive++;
            currentMutualPubkeys.push(pubkey);
            this.systemLogger.info(
              'MutualChangeDetector',
              `False positive prevented: ${pubkey.slice(0, 8)}... still follows`
            );
          } else {
            skippedUnknown++;
            currentMutualPubkeys.push(pubkey);
            this.systemLogger.info(
              'MutualChangeDetector',
              `Skipped ${pubkey.slice(0, 8)}...: verification unknown (${verdict.reason})`
            );
          }
        }
      }
      if (skippedUnknown > 0 || preventedFalsePositive > 0) {
        await this.debugLog.log('DOUBLE_CHECK_SUMMARY', {
          potentialUnfollows: potentialUnfollows.length,
          verifiedUnfollows: unfollows.length,
          falsePositivesPrevented: preventedFalsePositive,
          skippedUnknown,
          note: 'unknown verdicts are carried over — no unfollow notification'
        });
      }

      // New mutuals: in current but NOT in previous
      const newMutuals = currentMutualPubkeys.filter(
        pubkey => !previousMutuals.has(pubkey)
      );

      const totalChanges = unfollows.length + newMutuals.length;
      const durationMs = Date.now() - startTime;

      this.systemLogger.info('MutualChangeDetector',
        `Detection complete: ${unfollows.length} unfollows, ${newMutuals.length} new mutuals (${durationMs}ms)`
      );

      // Debug: Log full comparison result
      await this.debugLog.logComparison(
        previousSnapshot.mutualPubkeys,
        currentMutualPubkeys,
        unfollows,
        newMutuals
      );

      // Debug: Log individual detections
      for (const pubkey of unfollows) {
        await this.debugLog.logUnfollowDetected(pubkey, true);
      }
      for (const pubkey of newMutuals) {
        await this.debugLog.logNewMutualDetected(pubkey);
      }

      // Step 4: If changes detected, process them (store + notify)
      if (totalChanges > 0) {
        await this.processChanges(unfollows, newMutuals, currentUser.pubkey);
      }

      // Step 5: Save PENDING snapshot (NOT the acknowledged one!)
      // The acknowledged snapshot is only updated on markAsSeen()
      this.storage.savePendingSnapshot(currentMutualPubkeys);

      // Step 6: Add history entry to file
      // NOTE: We do NOT call saveToFile() here - the acknowledged snapshot
      // in the file should only be updated when user clicks "Mark as Seen"
      await this.storage.addHistoryEntry({
        timestamp: Date.now(),
        unfollowCount: unfollows.length,
        newMutualCount: newMutuals.length,
        durationMs
      });

      // Debug: Log check complete (no snapshot update!)
      await this.debugLog.logCheckComplete(unfollows, newMutuals, durationMs, currentMutualPubkeys.length);
      await this.debugLog.log('PENDING_SNAPSHOT_SAVED', {
        pendingMutualCount: currentMutualPubkeys.length,
        note: 'Acknowledged snapshot NOT updated - waiting for markAsSeen()'
      });

      return { unfollows, newMutuals, totalChanges, durationMs, isFirstCheck: false };
    } catch (_error) {
      this.systemLogger.error('MutualChangeDetector', `Detection failed: ${_error}`);
      await this.debugLog.logError(`Detection failed: ${_error}`, {
        stack: _error instanceof Error ? _error.stack : undefined
      });
      return { unfollows: [], newMutuals: [], totalChanges: 0, durationMs: Date.now() - startTime, isFirstCheck: false };
    }
  }

  /**
   * Process detected changes: store and create notifications
   */
  private async processChanges(
    unfollows: string[],
    newMutuals: string[],
    currentUserPubkey: string
  ): Promise<void> {
    const now = Date.now();
    const changes: MutualChange[] = [];

    // Create unfollow changes
    for (const pubkey of unfollows) {
      changes.push({
        pubkey,
        type: 'unfollow',
        detectedAt: now
      });

      // Create synthetic notification
      const eventId = await this.injectNotification(pubkey, 'mutual_unfollow', currentUserPubkey, now);

      // Debug: Log notification injection
      await this.debugLog.logNotificationInjected(pubkey, 'mutual_unfollow', eventId);
    }

    // Create new mutual changes
    for (const pubkey of newMutuals) {
      changes.push({
        pubkey,
        type: 'new_mutual',
        detectedAt: now
      });

      // Create synthetic notification
      const eventId = await this.injectNotification(pubkey, 'mutual_new', currentUserPubkey, now);

      // Debug: Log notification injection
      await this.debugLog.logNotificationInjected(pubkey, 'mutual_new', eventId);
    }

    // Store changes (appends to existing)
    this.storage.addChanges(changes);

    // Emit event for UI updates (green dot)
    this.eventBus.emit('mutual-changes:detected', {
      unfollowCount: unfollows.length,
      newMutualCount: newMutuals.length
    });

    this.systemLogger.info('MutualChangeDetector', `Processed ${changes.length} changes, notifications injected`);
  }

  /**
   * Inject synthetic notification into NotificationsOrchestrator
   * @returns The synthetic event ID for debug logging
   */
  private async injectNotification(
    pubkey: string,
    type: 'mutual_unfollow' | 'mutual_new',
    currentUserPubkey: string,
    timestamp?: number
  ): Promise<string> {
    const ts = timestamp || Date.now();
    const eventId = `mutual-${type}-${pubkey}-${ts}`;

    // Create synthetic NostrEvent (not published to relays)
    const syntheticEvent: NostrEvent = {
      id: eventId,
      pubkey: pubkey, // The person who unfollowed/followed
      kind: 99001, // Custom kind for mutual changes
      created_at: Math.floor(ts / 1000),
      tags: [
        ['type', type],
        ['p', currentUserPubkey]
      ],
      content: '',
      sig: '' // Empty - synthetic event
    };

    // Emit notification event (NotificationsOrchestrator listens)
    this.eventBus.emit('mutual-notification:new', {
      event: syntheticEvent,
      type
    });

    return eventId;
  }

  /**
   * Get detected changes (for UI display)
   */
  public getChanges(): MutualChange[] {
    return this.storage.getChanges();
  }

  /**
   * Mark all changes as seen:
   * - Updates snapshot to pending (acknowledges current state)
   * - Clears all stored changes
   * - Saves to file (this is the ONLY place where file snapshot is updated!)
   */
  public async markAsSeen(): Promise<void> {
    // Get pending snapshot and make it the acknowledged snapshot
    const pendingSnapshot = this.storage.getPendingSnapshot();
    const previousSnapshot = this.storage.getSnapshot();

    await this.debugLog.log('MARK_AS_SEEN_START', {
      pendingCount: pendingSnapshot?.length || 0,
      previousCount: previousSnapshot?.mutualPubkeys.length || 0,
      hasPending: !!pendingSnapshot
    });

    if (pendingSnapshot) {
      this.storage.saveSnapshot(pendingSnapshot);
      await this.debugLog.log('SNAPSHOT_ACKNOWLEDGED', {
        mutualCount: pendingSnapshot.length,
        note: 'User clicked Mark as Seen - pending snapshot is now acknowledged in localStorage'
      });
    }

    // Clear changes
    this.storage.clearChanges();

    // Save to file - this is the ONLY place where file snapshot gets updated!
    await this.storage.saveToFile();

    await this.debugLog.log('MARK_AS_SEEN_COMPLETE', {
      newSnapshotCount: pendingSnapshot?.length || previousSnapshot?.mutualPubkeys.length || 0,
      note: 'File updated with new acknowledged snapshot'
    });

    this.eventBus.emit('mutual-changes:seen');
    this.systemLogger.info('MutualChangeDetector', 'Changes marked as seen, snapshot updated');
  }

  /**
   * Check if there are unseen changes
   */
  public hasUnseenChanges(): boolean {
    return this.storage.hasUnseenChanges();
  }
}
