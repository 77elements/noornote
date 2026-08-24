/**
 * DMService - NIP-17 Direct Messages Orchestrator
 * Handles Gift Wrap encryption/decryption and subscription management
 *
 * @service DMService
 * @purpose Send and receive NIP-17 encrypted DMs
 * @used-by MessagesView, ConversationView
 *
 * Architecture (from NIP-17 spec):
 * - kind:14 = Chat Message (Rumor, unsigned)
 * - kind:13 = Seal (encrypted rumor, signed by sender)
 * - kind:1059 = Gift Wrap (encrypted seal, signed by ephemeral key)
 * - kind:10050 = DM Relay List (user's preferred DM relays)
 */

import {
  NDKEvent,
  NDKPrivateKeySigner,
  type NostrEvent,
  type NDKFilter,
} from '@nostr-dev-kit/ndk';
import { NostrTransport } from '../transport/NostrTransport';
import { AuthService } from '../AuthService';
import { RelayConfig } from '../RelayConfig';
import { DMStore, type DMMessage, type DMConversation } from './DMStore';
import { computeExpiresAt, isActive } from './DMExpiration';
import { TypedEventBus } from '../../core/TypedEventBus';
import { SystemLogger } from '../SystemLogger';
import { diagLog } from '../DiagnosticLogger';
import { FollowCheckService } from '../FollowCheckService';
import { MuteOrchestrator, muteUser } from '../../lists/mutes';
import { PerAccountLocalStorage, StorageKeys } from '../PerAccountLocalStorage';
import {
  generateSecretKey,
  getPublicKey,
  calculateEventHash,
} from '../../services/NostrToolsAdapter';

type InboxRelayCacheEntry = { relays: string[]; fetchedAt: number };
type InboxRelayCache = Record<string, InboxRelayCacheEntry>;

// NIP-17 Kind constants
const KIND_PRIVATE_MESSAGE = 14;
const KIND_SEAL = 13;
const KIND_GIFT_WRAP = 1059;
const KIND_DM_RELAY_LIST = 10050;

// NIP-04 Legacy Kind (deprecated but still widely used)
const KIND_LEGACY_DM = 4;

export class DMService {
  private static instance: DMService;
  private transport: NostrTransport;
  private authService: AuthService;
  private relayConfig: RelayConfig;
  private dmStore: DMStore;
  private eventBus: TypedEventBus;
  private systemLogger: SystemLogger;
  private followCheckService: FollowCheckService;
  private muteOrchestrator: ReturnType<typeof MuteOrchestrator.getInstance>;
  private subscriptionId: string | null = null;
  private userPubkey: string | null = null;
  private isStarting: boolean = false;

  // Cache for muted pubkeys (refreshed on mute:updated event)
  private mutedPubkeys: Set<string> = new Set();
  private mutedPubkeysLoaded: boolean = false;

  // Batch event emitting - collect events during fetch, emit once at end
  private isFetchingHistorical: boolean = false;
  private pendingBadgeUpdate: boolean = false;

  // Live-subscription backlog boundary. False while a live subscription is
  // replaying its initial `limit`-bounded backlog burst (every relay replays
  // recent events on (re)connect); flipped true on first EOSE or a safety
  // timeout. storeAndEmit suppresses dm:new-message while false, so a replayed
  // backlog — esp. after an IndexedDB eviction where hasMessage() can no longer
  // dedup — cannot flood toasts. Default true = emit, the safe no-op when no
  // live sub is active. See docs/todos/indexeddb-eviction-nwc-dm.md.
  private liveSubBacklogDone: boolean = true;
  private liveBacklogTimeout: number | null = null;
  private static readonly LIVE_BACKLOG_TIMEOUT_MS = 5000;

  // Progress tracking for UI
  private fetchProgress: { current: number; total: number } = {
    current: 0,
    total: 0,
  };

  // Periodic subscription refresh (browser WebSocket connections go stale)
  private refreshTimer: number | null = null;
  private isRefreshing: boolean = false;
  private static readonly REFRESH_INTERVAL = 30 * 60 * 1000; // 30 minutes

  // Periodic sweep of locally-expired DMs (NIP-40 expiration tag). 60s cadence
  // matches Nostur's "x ago" ticker piggy-back. Cheap: IDBKeyRange.upperBound
  // on the new expiresAt index, O(log n + k) where k = expired-today count.
  private expirySweepTimer: number | null = null;
  private static readonly EXPIRY_SWEEP_INTERVAL = 60 * 1000; // 60 seconds

  // Track active inbox relays to detect changes from relay sync
  private activeInboxRelays: string[] = [];

  // Coalesce incoming gift-wrapped events over a short window so bursts don't
  // cause one UI re-render per message. Dedup via DMStore wrapId unique index
  // keeps semantics correct even if a duplicate sneaks into the buffer.
  private incomingBatch: Array<{ event: NostrEvent; inBacklog: boolean }> = [];
  private incomingBatchTimer: number | null = null;
  private static readonly INCOMING_BATCH_WINDOW_MS = 50;

  // Incremental cold-start sync. NIP-17 gift wraps are backdated up to 48h
  // (see randomizeTimestamp); the relay filters on the OUTER randomized
  // created_at, so the incremental `since` must reach back at least that far
  // to not miss backdated wraps. 2 days matches the NIP-17 informal ceiling;
  // resyncAll() is the escape hatch for rarer outliers.
  private static readonly DM_BACKDATE_MARGIN_SECONDS = 2 * 24 * 60 * 60;
  // NIP-04 (kind:4) is NOT backdated — small clock-skew margin only.
  private static readonly DM_LEGACY_SKEW_SECONDS = 60 * 60;
  // Live subscription: bound the initial stored-event backlog. The live stream
  // after EOSE is NOT limited by this — it keeps delivering every new event.
  // NB: NDK treats `limit: 0` as falsy (it may drop it and dump the whole
  // history), so we use a real positive limit, not 0.
  private static readonly LIVE_BACKLOG_LIMIT = 100;

  private constructor() {
    this.transport = NostrTransport.getInstance();
    this.authService = AuthService.getInstance();
    this.relayConfig = RelayConfig.getInstance();
    this.dmStore = DMStore.getInstance();
    this.eventBus = TypedEventBus.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.followCheckService = FollowCheckService.getInstance();
    this.muteOrchestrator = MuteOrchestrator.getInstance();

    // Listen for mute updates to refresh cache
    this.eventBus.on('mute:updated', () => {
      void this.refreshMutedPubkeys();
    });

    // Listen for relay sync — re-subscribe if inbox relays changed
    this.eventBus.on('relays:updated', () => {
      this.handleRelayUpdate();
    });

    // Listen for logout - close DB connection (do NOT clear data - per-user DBs preserve data)
    this.eventBus.on('user:logout', () => {
      this.stop();
      this.dmStore.close();
    });

    // Defensive: also start on user:login directly, not just via PostLoginService.
    // PostLoginService.handleLogin has a guard (`loggedInPubkey === pubkey`)
    // that can prevent DMService.start() from running after a rapid
    // logout → re-login cycle (account switch). This listener ensures DMService
    // always starts for the new account regardless of that path. Idempotent —
    // start() exits early if already running for the same pubkey.
    this.eventBus.on('user:login', (data: { npub: string; pubkey: string }) => {
      if (this.userPubkey !== data.pubkey && !this.isStarting) {
        this.start().catch(err => {
          diagLog('dms', 'auto_start_failed', { error: String(err) });
        });
      }
    });
  }

  public static getInstance(): DMService {
    if (!DMService.instance) {
      DMService.instance = new DMService();
    }
    return DMService.instance;
  }

  /**
   * Start DM subscription (called on login)
   */
  public async start(): Promise<void> {
    try {
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) {
        this.systemLogger.warn('DMService', 'Cannot start - no user logged in');
        return;
      }

      // Bunker URL login cannot do NIP-44 — DMs not available
      if (this.authService.isBunkerAuth()) {
        diagLog('dms', 'DM service skipped — bunker auth cannot do NIP-44');
        this.eventBus.emit('dm:unsupported');
        return;
      }

      // Idempotency check - same user already running
      if (this.userPubkey === currentUser.pubkey && this.subscriptionId) {
        this.systemLogger.info('DMService', 'Already started for this user');
        // Still emit events so late subscribers (like MessagesView) get the data
        this.eventBus.emit('dm:fetch-complete');
        this.eventBus.emit('dm:badge-update');
        return;
      }

      // Prevent concurrent double-start. Two callers (user:login event +
      // explicit boot fallback) can reach this point in the same tick before
      // the first await sets userPubkey. This flag is set synchronously,
      // before any await, so the second caller sees it and exits.
      if (this.isStarting) {
        this.systemLogger.info(
          'DMService',
          'Start already in progress, skipping duplicate'
        );
        return;
      }
      this.isStarting = true;

      try {
        // Initialize per-user database (automatically switches if different user)
        await this.dmStore.init(currentUser.pubkey);

        // Set current user pubkey
        this.userPubkey = currentUser.pubkey;

        this.systemLogger.info(
          'DMService',
          `Starting DM service for ${currentUser.npub.slice(0, 12)}...`
        );
        diagLog('dms', 'DM service starting', {
          npub: currentUser.npub.slice(0, 12),
        });

        // Fetch historical messages first (don't block on errors)
        try {
          await this.fetchHistoricalMessages();
        } catch (fetchError) {
          diagLog('dms', 'Historical fetch failed', {
            error: String(fetchError),
          });
          this.systemLogger.warn(
            'DMService',
            'Error fetching historical messages:',
            fetchError
          );
        }

        // Start live subscription (don't block on errors)
        try {
          await this.startSubscription();
        } catch (subError) {
          diagLog('dms', 'Subscription start failed', {
            error: String(subError),
          });
          this.systemLogger.warn(
            'DMService',
            'Error starting subscription:',
            subError
          );
        }

        // Start periodic refresh timer (browser WebSocket connections go stale)
        this.startRefreshTimer();
        // Start the periodic sweep of locally-expired DMs (disappearing msgs).
        this.startExpirySweepTimer();

        diagLog('dms', 'DM service started');
        this.systemLogger.info('DMService', 'DM service started');
      } finally {
        this.isStarting = false;
      }
    } catch (error) {
      this.systemLogger.error(
        'DMService',
        'Failed to start DM service:',
        error
      );
      throw error;
    }
  }

  /**
   * Stop DM subscription (called on logout)
   */
  public stop(): void {
    this.clearRefreshTimer();
    this.clearExpirySweepTimer();
    this.clearIncomingBatchTimer();

    if (this.liveBacklogTimeout !== null) {
      clearTimeout(this.liveBacklogTimeout);
      this.liveBacklogTimeout = null;
    }
    this.liveSubBacklogDone = true;

    if (this.subscriptionId) {
      this.transport.unsubscribeLive(this.subscriptionId);
      this.subscriptionId = null;
    }

    this.userPubkey = null;
    this.isStarting = false;
    this.activeInboxRelays = [];
    this.incomingBatch = [];
    diagLog('dms', 'DM service stopped');
    this.systemLogger.info('DMService', 'DM service stopped');
  }

  private clearIncomingBatchTimer(): void {
    if (this.incomingBatchTimer !== null) {
      clearTimeout(this.incomingBatchTimer);
      this.incomingBatchTimer = null;
    }
  }

  /**
   * Begin a live-sub backlog burst window: suppress live emits until EOSE or
   * LIVE_BACKLOG_TIMEOUT_MS. The timeout is a safety net for relays that never
   * send EOSE, so genuine live DMs are never permanently suppressed.
   */
  private beginLiveBacklog(): void {
    this.liveSubBacklogDone = false;
    if (this.liveBacklogTimeout !== null) clearTimeout(this.liveBacklogTimeout);
    this.liveBacklogTimeout = window.setTimeout(
      () => this.onLiveBacklogDone(),
      DMService.LIVE_BACKLOG_TIMEOUT_MS
    );
  }

  /**
   * End the backlog burst (first EOSE wins; subsequent EOSEs / the timeout are
   * no-ops). Flush any badge updates accumulated during the suppressed burst so
   * the sidebar reflects re-ingested unread DMs even though no toast fired.
   */
  private onLiveBacklogDone(): void {
    if (this.liveSubBacklogDone) return; // idempotent against EOSE + timeout race
    this.liveSubBacklogDone = true;
    if (this.liveBacklogTimeout !== null) {
      clearTimeout(this.liveBacklogTimeout);
      this.liveBacklogTimeout = null;
    }
    if (this.pendingBadgeUpdate) {
      this.eventBus.emit('dm:badge-update');
      this.pendingBadgeUpdate = false;
    }
    diagLog('dms', 'DM live backlog done — live emits enabled');
  }

  /**
   * Flush the accumulated gift-wrap / legacy-DM events.
   * Processes events in parallel (decryption is independent per event);
   * errors on individual events are logged but don't stop the batch.
   */
  private async flushIncomingBatch(): Promise<void> {
    this.incomingBatchTimer = null;
    if (this.incomingBatch.length === 0) return;

    const batch = this.incomingBatch;
    this.incomingBatch = [];

    if (batch.length > 1) {
      diagLog('dms', 'Processing DM batch', { count: batch.length });
    }

    await Promise.all(
      batch.map(({ event, inBacklog }) => {
        if (event.kind === KIND_GIFT_WRAP)
          return this.processGiftWrap(event, inBacklog);
        if (event.kind === KIND_LEGACY_DM)
          return this.processLegacyDM(event, inBacklog);
        return Promise.resolve();
      })
    );
  }

  /**
   * Re-subscribe if inbox relays changed after a relay sync.
   * Called on 'relays:updated' event.
   */
  private handleRelayUpdate(): void {
    if (!this.userPubkey || !this.subscriptionId) return;

    const currentRelays = this.getMyInboxRelays().sort();
    const relaysUnchanged =
      currentRelays.length === this.activeInboxRelays.length &&
      currentRelays.every((url, i) => url === this.activeInboxRelays[i]);
    if (relaysUnchanged) return;

    diagLog('dms', 'Inbox relays changed, refreshing subscription', {
      old: this.activeInboxRelays.length,
      new: currentRelays.length,
    });
    this.systemLogger.info(
      'DMService',
      'Inbox relays changed, refreshing DM subscription'
    );
    void this.refreshSubscriptions();
  }

  /**
   * Refresh DM subscription - closes stale one and re-subscribes
   * Called periodically and on tab visibility change
   */
  public async refreshSubscriptions(): Promise<void> {
    if (!this.userPubkey || this.isRefreshing) return;

    this.isRefreshing = true;
    try {
      diagLog('dms', 'Refreshing DM subscription');
      this.systemLogger.info('DMService', '🔄 Refreshing DM subscription...');

      // 1. Close existing subscription
      if (this.subscriptionId) {
        this.transport.unsubscribeLive(this.subscriptionId);
        this.subscriptionId = null;
      }

      // 2. Fetch missed DMs from the last 35 minutes
      await this.fetchMissedMessages();

      // 3. Re-subscribe
      await this.startSubscription();

      // 4. Reset timer so it counts from now (avoids redundant refresh after visibility change)
      this.startRefreshTimer();

      this.systemLogger.info('DMService', '✅ DM subscription refreshed');
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Fetch missed DMs since last refresh interval
   * Lightweight version of fetchHistoricalMessages for catch-up
   */
  private async fetchMissedMessages(): Promise<void> {
    if (!this.userPubkey) return;

    // Capture before fetch so the cold-start checkpoint keeps advancing through
    // a long-running session (otherwise a restart re-fetches the whole session).
    const missedStartedAt = Math.floor(Date.now() / 1000);
    const since = missedStartedAt - 35 * 60; // last 35 minutes

    try {
      const inboxRelays = this.getMyInboxRelays();

      // NIP-17 Gift Wraps
      const nip17Events = await this.transport.fetch(
        inboxRelays,
        [
          {
            kinds: [KIND_GIFT_WRAP],
            '#p': [this.userPubkey],
            since,
          },
        ],
        10000,
        false,
        'DMService'
      );

      // Legacy NIP-04
      const readRelays = this.relayConfig.getReadRelays();
      const legacyEvents = await this.transport.fetch(
        readRelays,
        [
          {
            kinds: [KIND_LEGACY_DM],
            '#p': [this.userPubkey],
            since,
          },
        ],
        10000,
        false,
        'DMService'
      );

      for (const event of nip17Events) {
        await this.processGiftWrap(event, true);
      }
      for (const event of legacyEvents) {
        await this.processLegacyDM(event, true);
      }

      if (nip17Events.length > 0 || legacyEvents.length > 0) {
        diagLog('dms', 'Catch-up complete', {
          nip17: nip17Events.length,
          legacy: legacyEvents.length,
        });
        this.systemLogger.info(
          'DMService',
          `Caught up: ${nip17Events.length} NIP-17, ${legacyEvents.length} legacy events`
        );
        this.eventBus.emit('dm:badge-update');
      }

      // Advance the cold-start checkpoint — but only if one already exists, so a
      // refresh can't pre-empt the initial full seed on a fresh install.
      const store = PerAccountLocalStorage.getInstance();
      if (store.get<number>(StorageKeys.DM_LAST_SYNCED_AT, 0) > 0) {
        store.set(StorageKeys.DM_LAST_SYNCED_AT, missedStartedAt);
      }
    } catch (error) {
      diagLog('dms', 'Catch-up fetch failed', { error: String(error) });
      this.systemLogger.error(
        'DMService',
        'Failed to fetch missed messages:',
        error
      );
    }
  }

  /** Start periodic refresh timer */
  private startRefreshTimer(): void {
    this.clearRefreshTimer();
    this.refreshTimer = window.setInterval(() => {
      void this.refreshSubscriptions();
    }, DMService.REFRESH_INTERVAL);
  }

  /** Clear periodic refresh timer */
  private clearRefreshTimer(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Start the periodic sweep of locally-expired DMs. Removes messages whose
   * `expiresAt` (computed from the rumor's `expiration` tag) is in the past
   * and emits `dm:messages-expired` per affected conversation so the open
   * ConversationView can drop the bubbles without a full reload.
   */
  private startExpirySweepTimer(): void {
    this.clearExpirySweepTimer();
    // Run once immediately so a relaunched app purges anything that expired
    // while it was closed, then on the 60s cadence.
    void this.sweepExpiredMessages();
    this.expirySweepTimer = window.setInterval(() => {
      void this.sweepExpiredMessages();
    }, DMService.EXPIRY_SWEEP_INTERVAL);
  }

  private clearExpirySweepTimer(): void {
    if (this.expirySweepTimer !== null) {
      clearInterval(this.expirySweepTimer);
      this.expirySweepTimer = null;
    }
  }

  private async sweepExpiredMessages(): Promise<void> {
    try {
      const now = Math.floor(Date.now() / 1000);
      const { partnerPubkeys, count } =
        await this.dmStore.deleteExpiredBefore(now);
      if (count === 0) return;
      for (const partnerPubkey of partnerPubkeys) {
        this.eventBus.emit('dm:messages-expired', { partnerPubkey, count });
      }
    } catch (error) {
      diagLog('dms', 'expiry_sweep_failed', { error: String(error) });
    }
  }

  /**
   * Get current fetch progress (for UI progress bar)
   */
  public getFetchProgress(): {
    current: number;
    total: number;
    isLoading: boolean;
  } {
    return {
      ...this.fetchProgress,
      isLoading: this.isFetchingHistorical,
    };
  }

  /**
   * Fetch historical DMs from relays (NIP-17 + Legacy NIP-04)
   * - NIP-17 from inbox relays
   * - Legacy NIP-04 from read relays (they're on normal relays, not inbox)
   */
  private async fetchHistoricalMessages(): Promise<void> {
    if (!this.userPubkey) return;

    // Enter batch mode - suppress individual events
    this.isFetchingHistorical = true;
    this.pendingBadgeUpdate = false;
    this.fetchProgress = { current: 0, total: 0 };

    // Capture the sync start time BEFORE fetching, so messages that arrive
    // mid-sync are still covered by the next run's `since`. Persisted only on
    // success → a failed/interrupted sync keeps the previous checkpoint.
    const store = PerAccountLocalStorage.getInstance();
    const syncStartedAt = Math.floor(Date.now() / 1000);
    const lastSyncedAt = store.get<number>(StorageKeys.DM_LAST_SYNCED_AT, 0);
    const isIncremental = lastSyncedAt > 0;
    // Cold-start diagnostic: after an app update, a lost checkpoint (lastSyncedAt=0 despite
    // prior DM history) forces a seed fetch that re-notifies already-read messages. This log
    // makes that case observable instead of guessed.
    diagLog('dms', 'DM cold-start checkpoint', { lastSyncedAt, isIncremental });

    try {
      // NIP-17 uses inbox relays
      const inboxRelays = this.getMyInboxRelays();

      // Fetch NIP-17 Gift Wraps (kind:1059).
      // Incremental: only wraps newer than the checkpoint (minus the backdate
      // margin), no limit — the delta is small. Seed (first run): newest 500.
      const nip17Since = lastSyncedAt - DMService.DM_BACKDATE_MARGIN_SECONDS;
      const nip17Filter: NDKFilter = isIncremental
        ? {
            kinds: [KIND_GIFT_WRAP],
            '#p': [this.userPubkey],
            since: nip17Since,
          }
        : { kinds: [KIND_GIFT_WRAP], '#p': [this.userPubkey], limit: 500 };

      diagLog(
        'dms',
        isIncremental
          ? 'Fetching NIP-17 DMs (incremental)'
          : 'Fetching NIP-17 DMs (seed)',
        {
          relayCount: inboxRelays.length,
          since: isIncremental ? nip17Since : undefined,
        }
      );
      this.systemLogger.info(
        'DMService',
        `Fetching NIP-17 DMs from ${inboxRelays.length} inbox relays: ${inboxRelays.slice(0, 3).join(', ')}${inboxRelays.length > 3 ? '...' : ''}`
      );
      const nip17Events = await this.transport.fetch(
        inboxRelays,
        [nip17Filter],
        15000,
        false,
        'DMService'
      );
      diagLog('dms', 'NIP-17 fetch complete', { count: nip17Events.length });
      this.systemLogger.info(
        'DMService',
        `Fetched ${nip17Events.length} NIP-17 events`
      );

      // Legacy NIP-04 uses READ relays (normal relays, not specialized inbox).
      // Not backdated → small clock-skew margin only when incremental.
      const readRelays = this.relayConfig.getReadRelays();
      const legacySince = isIncremental
        ? lastSyncedAt - DMService.DM_LEGACY_SKEW_SECONDS
        : undefined;

      const legacyFilters: NDKFilter[] = [
        // Received DMs
        {
          kinds: [KIND_LEGACY_DM],
          '#p': [this.userPubkey],
          limit: 500,
          ...(legacySince !== undefined ? { since: legacySince } : {}),
        },
        // Sent DMs (our own messages)
        {
          kinds: [KIND_LEGACY_DM],
          authors: [this.userPubkey],
          limit: 500,
          ...(legacySince !== undefined ? { since: legacySince } : {}),
        },
      ];

      diagLog('dms', 'Fetching legacy NIP-04 DMs', {
        relayCount: readRelays.length,
        incremental: isIncremental,
      });
      this.systemLogger.info(
        'DMService',
        `Fetching legacy NIP-04 DMs from ${readRelays.length} read relays: ${readRelays.slice(0, 3).join(', ')}${readRelays.length > 3 ? '...' : ''}`
      );
      const legacyEvents = await this.transport.fetch(
        readRelays,
        legacyFilters,
        15000,
        false,
        'DMService'
      );
      diagLog('dms', 'Legacy NIP-04 fetch complete', {
        count: legacyEvents.length,
      });
      this.systemLogger.info(
        'DMService',
        `Fetched ${legacyEvents.length} legacy DM events`
      );

      // Set total for progress tracking
      const totalEvents = nip17Events.length + legacyEvents.length;
      this.fetchProgress.total = totalEvents;

      // Emit initial progress
      this.eventBus.emit('dm:fetch-progress', {
        current: 0,
        total: totalEvents,
      });

      // Process all events with unified progress tracking
      const allEvents: Array<{ event: NostrEvent; isNip17: boolean }> = [
        ...nip17Events.map(event => ({ event, isNip17: true })),
        ...legacyEvents.map(event => ({ event, isNip17: false })),
      ];

      for (const { event, isNip17 } of allEvents) {
        if (isNip17) {
          await this.processGiftWrap(event, true);
        } else {
          await this.processLegacyDM(event, true);
        }
        this.fetchProgress.current++;
        // Emit progress every 10 events to avoid flooding
        if (this.fetchProgress.current % 10 === 0) {
          this.eventBus.emit('dm:fetch-progress', { ...this.fetchProgress });
        }
      }

      // Persist the checkpoint only after a successful fetch (uses the pre-fetch
      // time, so no gap). Advances even on an empty delta → window slides forward.
      store.set(StorageKeys.DM_LAST_SYNCED_AT, syncStartedAt);

      // Seed the backward-paging cursor on the first (seed) run: the oldest
      // OUTER timestamp fetched marks the boundary for "load older" (Checkpoint C).
      if (!isIncremental && allEvents.length > 0) {
        const oldest = allEvents.reduce(
          (min, { event }) => Math.min(min, event.created_at),
          Number.POSITIVE_INFINITY
        );
        if (Number.isFinite(oldest)) {
          store.set(StorageKeys.DM_BACKWARD_CURSOR, oldest);
        }
      }
    } catch (error) {
      this.systemLogger.error(
        'DMService',
        'Failed to fetch historical messages:',
        error
      );
    } finally {
      // Exit batch mode - emit single consolidated event
      this.isFetchingHistorical = false;

      // Emit completion
      this.eventBus.emit('dm:fetch-progress', {
        current: this.fetchProgress.total,
        total: this.fetchProgress.total,
      });
      this.eventBus.emit('dm:fetch-complete');

      // If any messages were processed, emit a single badge update
      if (this.pendingBadgeUpdate) {
        this.eventBus.emit('dm:badge-update');
        this.pendingBadgeUpdate = false;
      }
    }
  }

  /**
   * Force a full DM re-sync from relays (escape hatch).
   * Clears the incremental checkpoint + backward cursor so the next fetch runs
   * the full-history seed again. Covers the rare case of a sender backdating a
   * gift wrap beyond the 2-day margin while the app was closed. Existing local
   * messages are preserved (dedup via wrapId); this only re-pulls from relays.
   */
  public async resyncAll(): Promise<void> {
    if (!this.userPubkey) return;
    const store = PerAccountLocalStorage.getInstance();
    store.remove(StorageKeys.DM_LAST_SYNCED_AT);
    store.remove(StorageKeys.DM_BACKWARD_CURSOR);
    diagLog('dms', 'Full DM resync requested');
    this.systemLogger.info('DMService', 'Re-syncing all DMs from relays...');
    await this.fetchHistoricalMessages();
  }

  /**
   * Load one page of OLDER history from relays, walking backward from the
   * persisted cursor (oldest outer wrap created_at fetched so far). On-demand,
   * so cold-start cost stays bounded. Returns whether the bottom was reached.
   */
  public async loadOlderMessages(): Promise<{
    fetched: number;
    reachedEnd: boolean;
  }> {
    if (!this.userPubkey) return { fetched: 0, reachedEnd: true };

    const store = PerAccountLocalStorage.getInstance();
    const cursor = store.get<number>(StorageKeys.DM_BACKWARD_CURSOR, 0);
    if (cursor <= 0) return { fetched: 0, reachedEnd: true };

    const PAGE_LIMIT = 200;

    // Batch mode: suppress per-message events, single badge update at the end.
    this.isFetchingHistorical = true;
    this.pendingBadgeUpdate = false;
    try {
      const inboxRelays = this.getMyInboxRelays();
      const readRelays = this.relayConfig.getReadRelays();

      // `until` is inclusive — the boundary event is re-fetched (deduped on write).
      const nip17Events = await this.transport.fetch(
        inboxRelays,
        [
          {
            kinds: [KIND_GIFT_WRAP],
            '#p': [this.userPubkey],
            until: cursor,
            limit: PAGE_LIMIT,
          },
        ],
        15000,
        false,
        'DMService'
      );

      const legacyEvents = await this.transport.fetch(
        readRelays,
        [
          {
            kinds: [KIND_LEGACY_DM],
            '#p': [this.userPubkey],
            until: cursor,
            limit: PAGE_LIMIT,
          },
          {
            kinds: [KIND_LEGACY_DM],
            authors: [this.userPubkey],
            until: cursor,
            limit: PAGE_LIMIT,
          },
        ],
        15000,
        false,
        'DMService'
      );

      const allEvents: Array<{ event: NostrEvent; isNip17: boolean }> = [
        ...nip17Events.map(event => ({ event, isNip17: true })),
        ...legacyEvents.map(event => ({ event, isNip17: false })),
      ];

      for (const { event, isNip17 } of allEvents) {
        if (isNip17) await this.processGiftWrap(event, true);
        else await this.processLegacyDM(event, true);
      }

      // No events at or before the cursor ⇒ bottom of history reached.
      const reachedEnd = nip17Events.length === 0 && legacyEvents.length === 0;
      if (!reachedEnd) {
        const oldest = allEvents.reduce(
          (min, { event }) => Math.min(min, event.created_at),
          Number.POSITIVE_INFINITY
        );
        // Advance strictly past the oldest we saw (guarantees forward progress).
        if (Number.isFinite(oldest)) {
          store.set(StorageKeys.DM_BACKWARD_CURSOR, oldest - 1);
        }
      }

      diagLog('dms', 'Loaded older DMs', {
        nip17: nip17Events.length,
        legacy: legacyEvents.length,
        reachedEnd,
      });
      return { fetched: allEvents.length, reachedEnd };
    } finally {
      this.isFetchingHistorical = false;
      if (this.pendingBadgeUpdate) {
        this.eventBus.emit('dm:badge-update');
        this.pendingBadgeUpdate = false;
      }
    }
  }

  /**
   * Start live subscription for new DMs (NIP-17 + Legacy NIP-04)
   */
  private async startSubscription(): Promise<void> {
    if (!this.userPubkey) return;

    const relays = this.getMyInboxRelays();
    this.activeInboxRelays = relays.slice().sort();

    // Live subscription filters — deliberately NO `since`. NIP-17 gift wraps
    // (kind:1059) carry a created_at randomized up to 2 days into the past
    // (NIP-59), and relays apply `since` to that backdated timestamp — so any
    // `since` on a live sub silently drops wraps that arrive now but look old
    // (the reason DMs only surfaced after a reload). Without `since`, the relay
    // streams every new wrap live regardless of created_at, bulletproof against
    // any amount of backdating. The positive `limit` only bounds the initial
    // stored backlog (deduped by hasMessage / DMStore); the post-EOSE live
    // stream is unaffected by it. Historical backfill is handled separately by
    // fetchHistoricalMessages()/fetchMissedMessages().
    const filters: NDKFilter[] = [
      // NIP-17 Gift Wraps
      {
        kinds: [KIND_GIFT_WRAP],
        '#p': [this.userPubkey],
        limit: DMService.LIVE_BACKLOG_LIMIT,
      },
      // Legacy NIP-04 received
      {
        kinds: [KIND_LEGACY_DM],
        '#p': [this.userPubkey],
        limit: DMService.LIVE_BACKLOG_LIMIT,
      },
    ];

    this.subscriptionId = 'dm-subscription';

    // Mark the live sub as "in backlog burst" until EOSE (or safety timeout).
    // Events arriving before EOSE are the relay's replayed backlog and must not
    // emit dm:new-message — see storeAndEmit().
    this.beginLiveBacklog();

    await this.transport.subscribeLive(
      relays,
      filters,
      this.subscriptionId,
      (event: NostrEvent) => {
        // Stamp the backlog-gate state AT ARRIVAL. The downstream pipeline
        // (batch window + NIP-55 signer decryption) is asynchronous and can
        // easily outlast the EOSE/timeout that opens the gate — checking the
        // gate at emission time let a replayed backlog through as "live"
        // (the recurring false-unread-toast bug). An event that arrived
        // during the backlog burst can never be a live notification.
        this.incomingBatch.push({
          event,
          inBacklog: !this.liveSubBacklogDone,
        });
        if (this.incomingBatchTimer === null) {
          this.incomingBatchTimer = window.setTimeout(
            () => this.flushIncomingBatch(),
            DMService.INCOMING_BATCH_WINDOW_MS
          );
        }
      },
      () => this.onLiveBacklogDone()
    );

    diagLog('dms', 'Live subscription active', {
      relayCount: relays.length,
      relays: relays.slice(0, 3),
    });
    this.systemLogger.info(
      'DMService',
      `Live subscription active on ${relays.length} relays`
    );
  }

  /**
   * Process a gift-wrapped event (unwrap and store)
   * @param arrivedDuringBacklog - true when the event arrived via the live
   *        sub before its EOSE (replayed backlog); forwarded to storeAndEmit
   *        so it never emits dm:new-message regardless of decrypt latency.
   */
  private async processGiftWrap(
    wrapEvent: NostrEvent,
    arrivedDuringBacklog = false
  ): Promise<void> {
    try {
      // Check if already processed
      const wrapId = wrapEvent.id;
      if (!wrapId || (await this.dmStore.hasMessage(wrapId))) {
        return;
      }

      // NIP-40 (expiration): if the wrap itself is already expired, drop it
      // before spending cycles on decryption. Some relays honor NIP-40 and
      // stop serving expired events, but many don't — so the client MUST
      // enforce this locally. Otherwise an expired disappearing-DM gets
      // re-saved on every historical re-fetch, only to be re-deleted by the
      // next sweep — a tight infinite loop.
      const now = Math.floor(Date.now() / 1000);
      const wrapExpiration = this.getTagValue(wrapEvent.tags, 'expiration');
      if (wrapExpiration && Number(wrapExpiration) <= now) {
        diagLog('dms', 'expired_wrap_dropped', {
          wrapId: wrapId.slice(0, 8),
          expiredAgo: now - Number(wrapExpiration),
        });
        return;
      }

      // Unwrap: GiftWrap -> Seal -> Rumor
      const rumor = await this.unwrapGiftWrap(wrapEvent);

      if (!rumor) {
        return;
      }

      // Determine conversation partner
      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) return;

      const conversationWith =
        rumor.pubkey === currentUser.pubkey
          ? this.getRecipientFromTags(rumor.tags) || ''
          : rumor.pubkey;

      if (!conversationWith) {
        this.systemLogger.warn(
          'DMService',
          'Could not determine conversation partner'
        );
        return;
      }

      // Extract metadata from tags
      const replyTo = this.getTagValue(rumor.tags, 'e', 'reply');
      const subject = this.getTagValue(rumor.tags, 'subject');
      // NIP-40 expiration tag (disappearing DMs). The tag value is the
      // absolute unix timestamp at which the message expires (NIP-40 spec),
      // so we use it directly as `expiresAt`. The gift wrap carries its own
      // copy for relay-side deletion; the rumor's tag (inside the encrypted
      // seal) is what we use for local cleanup.
      const expirationTag = this.getTagValue(rumor.tags, 'expiration');
      const expiresAt = expirationTag ? Number(expirationTag) : undefined;

      // If the rumor is already expired, drop it. Same rationale as the
      // wrap-level check above: prevents re-saving already-expired messages
      // that arrive via historical fetches or non-NIP-40-honoring relays.
      if (typeof expiresAt === 'number' && expiresAt <= now) {
        diagLog('dms', 'expired_rumor_dropped', {
          rumorId: (rumor.id || '').slice(0, 8),
          expiredAgo: now - expiresAt,
        });
        return;
      }

      // Create message record
      const message: DMMessage = {
        id: rumor.id || wrapId,
        pubkey: rumor.pubkey,
        content: rumor.content,
        createdAt: rumor.created_at,
        conversationWith,
        isMine: rumor.pubkey === currentUser.pubkey,
        wrapId,
        format: 'nip17',
      };
      if (replyTo) message.replyTo = replyTo;
      if (subject) message.subject = subject;
      if (typeof expiresAt === 'number') message.expiresAt = expiresAt;

      // Peer-duration acceptance gate (incoming tagged messages only):
      //   - If our `disappearingSeconds` matches the message's duration → accept
      //   - If `lastPromptedPeerDuration` matches but `disappearingSeconds` doesn't
      //     → user already said No to this duration, silently drop
      //   - Otherwise → store + show banner (re-prompt)
      // Own messages (isMine) bypass the gate.
      if (typeof expiresAt === 'number' && !message.isMine) {
        const peerDuration = expiresAt - rumor.created_at;
        const acceptedDuration =
          await this.dmStore.getDisappearing(conversationWith);
        const lastPrompted =
          await this.dmStore.getLastPromptedPeerDuration(conversationWith);
        // Already accepted this exact duration → store normally, no prompt.
        if (acceptedDuration === peerDuration) {
          // ok, fall through
        } else if (lastPrompted === peerDuration) {
          // Previously rejected this duration — silently drop.
          diagLog('dms', 'rejected_duration_dropped', {
            partner: conversationWith.slice(0, 8),
            peerDuration,
          });
          return;
        }
        // else: store + emit request below so the banner prompts the user.
      }

      await this.storeAndEmit(message, conversationWith, arrivedDuringBacklog);

      // If the peer sent a message with a duration we haven't yet accepted
      // AND haven't yet been prompted about, fire a request event so the
      // open ConversationView can show the banner.
      if (
        typeof expiresAt === 'number' &&
        message.pubkey !== currentUser.pubkey
      ) {
        const peerDuration = expiresAt - rumor.created_at;
        const acceptedDuration =
          await this.dmStore.getDisappearing(conversationWith);
        const lastPrompted =
          await this.dmStore.getLastPromptedPeerDuration(conversationWith);
        if (
          acceptedDuration !== peerDuration &&
          lastPrompted !== peerDuration
        ) {
          this.eventBus.emit('dm:disappearing-request', {
            partnerPubkey: conversationWith,
          });
        }
      }
    } catch (error) {
      this.systemLogger.error(
        'DMService',
        'Error processing gift wrap:',
        error
      );
    }
  }

  /**
   * Process a legacy NIP-04 DM (kind:4)
   * @param arrivedDuringBacklog - see processGiftWrap
   */
  private async processLegacyDM(
    event: NostrEvent,
    arrivedDuringBacklog = false
  ): Promise<void> {
    try {
      // Check if already processed
      const eventId = event.id;
      if (!eventId || (await this.dmStore.hasMessage(eventId))) {
        return;
      }

      const currentUser = this.authService.getCurrentUser();
      if (!currentUser) return;

      // Determine if we sent or received this message
      const isMine = event.pubkey === currentUser.pubkey;

      // Get the conversation partner from p-tag
      const pTag = event.tags.find(t => t[0] === 'p');
      const recipientPubkey = pTag?.[1];
      if (!recipientPubkey) {
        // No p-tag or empty - malformed DM
        return;
      }

      const conversationWith = isMine ? recipientPubkey : event.pubkey;

      // Decrypt the content using NIP-04
      let decryptedContent: string;
      try {
        // For received messages, decrypt with sender's pubkey
        // For sent messages, decrypt with recipient's pubkey
        const decryptPubkey = isMine ? recipientPubkey : event.pubkey;
        decryptedContent = await this.authService.nip04Decrypt(
          event.content,
          decryptPubkey
        );
      } catch (decryptError) {
        // Decryption failed - could be corrupted or not meant for us
        diagLog('dms', 'Legacy DM decrypt failed', {
          eventId: eventId.slice(0, 8),
        });
        // Only log during live subscription, not during batch fetch
        if (!this.isFetchingHistorical) {
          this.systemLogger.warn(
            'DMService',
            `Failed to decrypt legacy DM ${eventId.slice(0, 8)}`
          );
        }
        return;
      }

      // Create message record
      const message: DMMessage = {
        id: eventId,
        pubkey: event.pubkey,
        content: decryptedContent,
        createdAt: event.created_at,
        conversationWith,
        isMine,
        wrapId: eventId, // Use event ID as wrapId for dedup
        format: 'legacy',
      };

      await this.storeAndEmit(message, conversationWith, arrivedDuringBacklog);
    } catch (error) {
      this.systemLogger.error(
        'DMService',
        'Error processing legacy DM:',
        error
      );
    }
  }

  /**
   * Store a message and emit appropriate events.
   * Batches events during historical fetch, emits immediately for live messages.
   *
   * Live-notification rules (the anti-false-toast defence stack):
   *  1. `arrivedDuringBacklog` — stamped AT ARRIVAL in the live-sub callback.
   *     The downstream batch/decrypt pipeline is async (NIP-55 signer IPC can
   *     take seconds for a backlog), so the EOSE gate can be long open by the
   *     time we get here; the arrival stamp is the only race-free signal.
   *  2. `isFetchingHistorical` — explicit historical fetches never notify.
   *  3. `wasUnread` — DMStore's read-anchor verdict. Even a genuinely-live
   *     arrival that the store classified as already-read (replay of a read
   *     conversation) carries wasUnread:false so consumers (UnknownDMNotifier)
   *     never present it as a new unread message.
   */
  private async storeAndEmit(
    message: DMMessage,
    conversationWith: string,
    arrivedDuringBacklog = false
  ): Promise<void> {
    const { inserted, unreadBumped } = await this.dmStore.saveMessage(message);

    // Duplicate (already stored under this wrapId) — nothing new, no events.
    if (!inserted) return;

    const isLive =
      !arrivedDuringBacklog &&
      !this.isFetchingHistorical &&
      this.liveSubBacklogDone;
    if (!isLive) {
      this.pendingBadgeUpdate = true;
    } else {
      if (!message.isMine) {
        diagLog('dms', 'DM live notification emitted', {
          createdAt: message.createdAt,
          wasUnread: unreadBumped,
        });
      }
      this.eventBus.emit('dm:new-message', {
        message,
        conversationWith,
        wasUnread: unreadBumped,
      });
      this.eventBus.emit('dm:badge-update');
    }
  }

  /**
   * Unwrap a gift-wrapped event to get the rumor
   * Uses AuthService for decryption (works with all signer types)
   */
  private async unwrapGiftWrap(
    wrapEvent: NostrEvent
  ): Promise<NostrEvent | null> {
    try {
      // Step 1: Decrypt gift wrap content to get seal (kind:13)
      // The wrapper is signed by ephemeral key, content encrypted to recipient
      const sealJson = await this.authService.nip44Decrypt(
        wrapEvent.content,
        wrapEvent.pubkey
      );

      if (!sealJson) {
        return null;
      }

      const seal = JSON.parse(sealJson) as NostrEvent;

      // Verify seal is kind:13
      if (seal.kind !== KIND_SEAL) {
        diagLog('dms', 'Unexpected seal kind', {
          expected: KIND_SEAL,
          got: seal.kind,
        });
        return null;
      }

      // Step 2: Decrypt seal content to get rumor (kind:14)
      // The seal is signed by the actual sender
      const rumorJson = await this.authService.nip44Decrypt(
        seal.content,
        seal.pubkey
      );

      if (!rumorJson) {
        return null;
      }

      const rumor = JSON.parse(rumorJson) as NostrEvent;

      // Verify rumor is kind:14
      if (rumor.kind !== KIND_PRIVATE_MESSAGE) {
        return null;
      }

      // Anti-spoofing: verify rumor.pubkey === seal.pubkey
      if (rumor.pubkey !== seal.pubkey) {
        diagLog('dms', 'Spoofing detected: rumor.pubkey !== seal.pubkey', {
          rumor: rumor.pubkey.slice(0, 8),
          seal: seal.pubkey.slice(0, 8),
        });
        this.systemLogger.warn(
          'DMService',
          'Spoofing detected: rumor.pubkey !== seal.pubkey'
        );
        return null;
      }

      return rumor;
    } catch (error) {
      diagLog('dms', 'Gift wrap unwrap failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Send a DM to a recipient
   */
  public async sendMessage(
    recipientPubkey: string,
    content: string,
    replyTo?: string
  ): Promise<boolean> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) {
      this.systemLogger.error('DMService', 'Cannot send - no user logged in');
      return false;
    }

    try {
      diagLog('dms', 'Sending DM', { to: recipientPubkey.slice(0, 8) });
      this.systemLogger.info(
        'DMService',
        `Sending DM to ${recipientPubkey.slice(0, 8)}...`
      );

      // Look up the per-conversation disappearing setting. If active (>0) the
      // outgoing rumor gets an `expiration` tag and the wrap event too — see
      // createGiftWrap. The tag value is the absolute unix timestamp at which
      // the message should expire (NIP-40), computed from the real send time.
      const disappearingSeconds =
        await this.dmStore.getDisappearing(recipientPubkey);
      const useDisappearing = isActive(disappearingSeconds);

      // Step 1: Create rumor (kind:14, UNSIGNED but with calculated id)
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = useDisappearing
        ? computeExpiresAt(now, disappearingSeconds as number)
        : undefined;
      const tags: string[][] = [['p', recipientPubkey]];

      if (replyTo) {
        tags.push(['e', replyTo, '', 'reply']);
      }
      if (useDisappearing && typeof expiresAt === 'number') {
        tags.push(['expiration', String(expiresAt)]);
      }

      const rumorBase = {
        kind: KIND_PRIVATE_MESSAGE,
        pubkey: currentUser.pubkey,
        created_at: now,
        content,
        tags,
      };

      // Calculate id for rumor (NIP-17 requires id but no signature)
      const rumorId = calculateEventHash(rumorBase);
      const rumor: NostrEvent = {
        ...rumorBase,
        id: rumorId,
        sig: '', // No signature for rumor
      };

      // Step 2-4: Build both gift wraps + fetch recipient's inbox relays in parallel.
      // Self-copy creation is allowed to fail silently (recipient delivery is what matters).
      // Pass expiresAt so the wrap also carries the NIP-40 tag for relay-side deletion.
      const myRelays = this.getMyInboxRelays();
      const [recipientWrap, selfWrap, recipientRelays] = await Promise.all([
        this.createGiftWrap(rumor, recipientPubkey, expiresAt),
        this.createGiftWrap(rumor, currentUser.pubkey, expiresAt).catch(
          () => null
        ),
        this.getUserInboxRelays(recipientPubkey),
      ]);

      if (!recipientWrap) {
        throw new Error('Failed to create gift wrap for recipient');
      }

      // Step 5: Publish both wraps in parallel. Self-copy failure must not abort
      // the send — recipient delivery is authoritative.
      // requiredRelayCount=1: resolve as soon as one relay ACKs (delivery is
      // guaranteed once any inbox relay has the event). Writes to the remaining
      // relays continue in the background — full redundancy preserved.
      const publishResults = await Promise.allSettled([
        this.transport.publishToInbox(recipientWrap, recipientRelays, 1),
        selfWrap
          ? this.transport.publishToInbox(selfWrap, myRelays, 1)
          : Promise.resolve(),
      ]);

      if (publishResults[0].status === 'rejected') {
        // Purge cached relays — recipient may have changed their kind:10050.
        // Next send attempt re-fetches and may succeed.
        this.invalidateInboxRelayCache(recipientPubkey);
        throw new Error(
          `Recipient publish failed: ${publishResults[0].reason}`
        );
      }

      diagLog('dms', 'DM published to recipient', {
        relayCount: recipientRelays.length,
      });
      this.systemLogger.info(
        'DMService',
        `Sent to recipient on ${recipientRelays.length} relays`
      );

      if (selfWrap && publishResults[1].status === 'fulfilled') {
        this.systemLogger.info('DMService', 'Self-copy published');
      } else if (selfWrap && publishResults[1].status === 'rejected') {
        this.systemLogger.warn(
          'DMService',
          `Self-copy publish failed: ${publishResults[1].reason} (recipient delivery OK)`
        );
      }

      // Step 6: Store message locally with selfWrap.id as wrapId
      // This ensures that when the self-copy comes back from the relay,
      // hasMessage(selfWrap.id) returns true and it's skipped as duplicate.
      // Use the deterministic rumor id (not a temp id) so the optimistic copy
      // and the echoed/decrypted copy share the SAME id — the open conversation
      // dedups on it, and reply references resolve to a real event id.
      const wrapId = selfWrap?.id ?? recipientWrap.id ?? `local-${Date.now()}`;
      const message: DMMessage = {
        id: rumorId,
        pubkey: currentUser.pubkey,
        content,
        createdAt: now,
        conversationWith: recipientPubkey,
        isMine: true,
        wrapId,
        format: 'nip17', // We always send NIP-17
      };
      if (replyTo) message.replyTo = replyTo;
      if (typeof expiresAt === 'number') message.expiresAt = expiresAt;

      await this.dmStore.saveMessage(message);

      // Emit dm:new-message so ConversationView updates
      this.eventBus.emit('dm:new-message', {
        message,
        conversationWith: recipientPubkey,
      });

      return true;
    } catch (error) {
      diagLog('dms', 'Send message failed', {
        to: recipientPubkey.slice(0, 8),
        error: String(error),
      });
      this.systemLogger.error('DMService', 'Failed to send message:', error);
      return false;
    }
  }

  /**
   * Create a gift-wrapped event
   * Rumor -> Seal -> Gift Wrap
   */
  /**
   * Create a gift-wrapped event
   * Rumor -> Seal -> Gift Wrap
   *
   * If `expiresAt` is provided, an `expiration` tag is attached to the gift
   * wrap (NIP-40) so relays delete the wrap when it expires. The seal is left
   * tagless (NIP-59 says seal tags MUST be empty, which contradicts NIP-17's
   * "SHOULD" — see docs/todos/disappearing-dms.md).
   */
  private async createGiftWrap(
    rumor: NostrEvent,
    recipientPubkey: string,
    expiresAt?: number
  ): Promise<NostrEvent | null> {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return null;

    try {
      // Step 1: Create seal (encrypt rumor, sign with sender's key)
      const rumorJson = JSON.stringify(rumor);
      const encryptedRumor = await this.authService.nip44Encrypt(
        rumorJson,
        recipientPubkey
      );

      const sealTimestamp = this.randomizeTimestamp(
        Math.floor(Date.now() / 1000)
      );
      const unsignedSeal = {
        kind: KIND_SEAL,
        pubkey: currentUser.pubkey,
        created_at: sealTimestamp,
        content: encryptedRumor,
        tags: [] as string[][], // MUST be empty per NIP-17
      };

      const signedSeal = await this.authService.signEvent(unsignedSeal);

      // Step 2: Create gift wrap (encrypt seal with ephemeral key)
      const ephemeralSecretKey = generateSecretKey();
      const ephemeralPubkey = getPublicKey(ephemeralSecretKey);
      // Convert Uint8Array to hex string (browser-compatible, no Buffer)
      const ephemeralHex = Array.from(ephemeralSecretKey)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
      const ephemeralSigner = new NDKPrivateKeySigner(ephemeralHex);

      const sealJson = JSON.stringify(signedSeal);

      // Create NDK instance for encryption
      const ndk = this.transport.getNDK();
      const recipientUser = ndk.getUser({ pubkey: recipientPubkey });

      // Encrypt seal with ephemeral key -> recipient
      const encryptedSeal = await ephemeralSigner.encrypt(
        recipientUser,
        sealJson,
        'nip44'
      );

      const wrapTimestamp = this.randomizeTimestamp(
        Math.floor(Date.now() / 1000)
      );
      const wrapTags: string[][] = [['p', recipientPubkey]];
      if (typeof expiresAt === 'number') {
        wrapTags.push(['expiration', String(expiresAt)]);
      }
      const unsignedWrap = {
        kind: KIND_GIFT_WRAP,
        pubkey: ephemeralPubkey,
        created_at: wrapTimestamp,
        content: encryptedSeal,
        tags: wrapTags,
      };

      // Sign with ephemeral key
      const wrapEvent = new NDKEvent(ndk, unsignedWrap);
      await wrapEvent.sign(ephemeralSigner);

      return wrapEvent.rawEvent();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      diagLog('dms', 'Gift wrap creation failed', { error: errorMsg });
      this.systemLogger.error(
        'DMService',
        `Failed to create gift wrap: ${errorMsg}`
      );
      return null;
    }
  }

  /**
   * Randomize timestamp (up to 48 hours in the past per NIP-17)
   */
  private randomizeTimestamp(timestamp: number): number {
    const maxOffset = 48 * 60 * 60; // 48 hours in seconds
    const randomOffset = Math.floor(Math.random() * maxOffset);
    return timestamp - randomOffset;
  }

  /** Default fallback DM inbox relays (NIP-17 + NIP-42 AUTH capable).
   *  Mirrors the onboarding INBOX_RELAYS so DM routing for users without a
   *  published kind:10050 lands on the same set the wizard seeds. */
  private readonly FALLBACK_INBOX_RELAYS = [
    'wss://relay.0xchat.com',
    'wss://auth.nostr1.com',
  ];

  /**
   * Get current user's inbox relays (configured or fallback)
   */
  private getMyInboxRelays(): string[] {
    const inbox = this.relayConfig.getInboxRelays();
    const readRelays = this.relayConfig.getReadRelays();
    const combined = [
      ...new Set([
        ...(inbox.length > 0 ? inbox : this.FALLBACK_INBOX_RELAYS),
        ...readRelays,
      ]),
    ];
    return combined;
  }

  /**
   * Get a user's inbox relays (kind:10050)
   * Used when SENDING DMs to determine where to publish
   */
  public async getUserInboxRelays(pubkey: string): Promise<string[]> {
    try {
      // For own user: use configured inbox relays (or fallback)
      if (pubkey === this.userPubkey) {
        return this.getMyInboxRelays();
      }

      // Persistent cache (0xchat model: fetch once, trust until publish fails).
      // Entry is cleared via invalidateInboxRelayCache() on recipient-publish failure.
      const cache = this.getInboxRelayCache();
      const cached = cache[pubkey];
      if (cached && cached.relays.length > 0) {
        return cached.relays;
      }

      // Cache miss: fetch kind:10050 from read relays + the recipient's NIP-65
      // write relays (outbound). kind:10050 is replaceable metadata and SHOULD
      // be on metadata aggregators (purplepag.es) and the user's own outbox —
      // querying only our read relays misses recipients who don't overlap.
      const { OutboundRelaysOrchestrator } = await import(
        '../orchestration/OutboundRelaysOrchestrator'
      );
      const relays =
        await OutboundRelaysOrchestrator.getInstance().getCombinedRelays(
          [pubkey],
          true
        );
      const filter: NDKFilter = {
        kinds: [KIND_DM_RELAY_LIST],
        authors: [pubkey],
        limit: 1,
      };

      const events = await this.transport.fetch(
        relays,
        [filter],
        5000,
        false,
        'DMService'
      );

      const event = events[0];
      if (event) {
        const dmRelays = event.tags
          .filter(
            (t): t is [string, string, ...string[]] =>
              t[0] === 'relay' && typeof t[1] === 'string'
          )
          .map(t => t[1]);

        if (dmRelays.length > 0) {
          this.systemLogger.info(
            'DMService',
            `Found kind:10050 for ${pubkey.slice(0, 8)} with ${dmRelays.length} DM relays`
          );
          const aggregators = this.relayConfig.getAggregatorRelays();
          const merged = [...new Set([...dmRelays, ...aggregators])];

          // Persist to cache — lookups for this recipient skip the relay round-trip.
          cache[pubkey] = { relays: merged, fetchedAt: Date.now() };
          this.setInboxRelayCache(cache);

          return merged;
        }
      }

      // No kind:10050 published by user — aggregator fallback, NOT cached
      // (so a later publish by the user is picked up on next send).
      return this.relayConfig.getAggregatorRelays();
    } catch {
      this.systemLogger.warn(
        'DMService',
        `Failed to fetch inbox relays for ${pubkey.slice(0, 8)}`
      );
      return this.relayConfig.getAggregatorRelays();
    }
  }

  private getInboxRelayCache(): InboxRelayCache {
    return PerAccountLocalStorage.getInstance().get<InboxRelayCache>(
      StorageKeys.DM_INBOX_RELAYS_CACHE,
      {}
    );
  }

  private setInboxRelayCache(cache: InboxRelayCache): void {
    PerAccountLocalStorage.getInstance().set(
      StorageKeys.DM_INBOX_RELAYS_CACHE,
      cache
    );
  }

  /**
   * Purge a recipient's cached inbox relays. Called after a recipient-publish
   * failure so the next send re-fetches kind:10050 (catches relay-list changes).
   */
  private invalidateInboxRelayCache(pubkey: string): void {
    const cache = this.getInboxRelayCache();
    if (cache[pubkey]) {
      delete cache[pubkey];
      this.setInboxRelayCache(cache);
      diagLog('dms', 'Inbox relay cache invalidated', {
        pubkey: pubkey.slice(0, 8),
      });
    }
  }

  /**
   * Get recipient pubkey from p-tags (for determining conversation partner on own messages)
   */
  private getRecipientFromTags(tags: string[][]): string | null {
    const currentUser = this.authService.getCurrentUser();
    if (!currentUser) return null;

    for (const tag of tags) {
      const pubkey = tag[1];
      if (tag[0] === 'p' && pubkey && pubkey !== currentUser.pubkey) {
        return pubkey;
      }
    }

    return null;
  }

  /**
   * Get tag value by name and optional marker
   */
  private getTagValue(
    tags: string[][],
    name: string,
    marker?: string
  ): string | undefined {
    for (const tag of tags) {
      if (tag[0] === name) {
        if (marker) {
          // For e-tags with markers (e.g., ['e', 'eventId', 'relay', 'reply'])
          if (tag[3] === marker) {
            return tag[1];
          }
        } else {
          // For simple tags (e.g., ['subject', 'Hello'])
          return tag[1];
        }
      }
    }
    return undefined;
  }

  /**
   * Get total unread count (excludes muted users)
   */
  public async getUnreadCount(): Promise<number> {
    await this.loadMutedPubkeys();

    const conversations = await this.dmStore.getConversations();
    let total = 0;

    for (const conv of conversations) {
      if (!this.isMutedSync(conv.pubkey)) {
        total += conv.unreadCount;
      }
    }

    return total;
  }

  /**
   * Get conversations with pagination
   */
  public async getConversations(limit?: number, offset: number = 0) {
    return this.dmStore.getConversations(limit, offset);
  }

  /**
   * Get messages for a conversation
   */
  public async getMessages(
    partnerPubkey: string,
    limit?: number,
    before?: number
  ) {
    return this.dmStore.getMessages(partnerPubkey, limit, before);
  }

  /**
   * Mark conversation as read
   */
  public async markAsRead(partnerPubkey: string) {
    await this.dmStore.markAsRead(partnerPubkey);
    this.eventBus.emit('dm:badge-update');
    this.eventBus.emit('dm:read', { partnerPubkey });
  }

  /**
   * Mark all conversations as read
   */
  public async markAllAsRead(): Promise<void> {
    await this.dmStore.markAllAsRead();
    this.eventBus.emit('dm:badge-update');
    this.eventBus.emit('dm:all-read');
  }

  /**
   * Mark all conversations as unread
   */
  public async markAllAsUnread(): Promise<void> {
    await this.dmStore.markAllAsUnread();
    this.eventBus.emit('dm:badge-update');
  }

  /**
   * Get the per-conversation disappearing-messages setting.
   * Returns:
   *   undefined → undecided
   *   0         → off
   *   >0        → seconds (active)
   */
  public async getDisappearing(
    partnerPubkey: string
  ): Promise<number | undefined> {
    return this.dmStore.getDisappearing(partnerPubkey);
  }

  /**
   * Update the per-conversation disappearing-messages setting and notify
   * listeners. Pass `undefined` to reset to undecided, 0 for off, >0 for a
   * preset duration in seconds. Setting this does NOT retroactively delete
   * or tag existing messages — it only applies to future outgoing messages.
   */
  public async setDisappearing(
    partnerPubkey: string,
    seconds: number | undefined
  ): Promise<void> {
    await this.dmStore.setDisappearing(partnerPubkey, seconds);
    this.eventBus.emit('dm:disappearing-changed', { partnerPubkey, seconds });
    diagLog('dms', 'disappearing_setting_changed', {
      partner: partnerPubkey.slice(0, 8),
      seconds,
    });
  }

  /** Read the peer duration we last prompted about (Yes or No). */
  public async getLastPromptedPeerDuration(
    partnerPubkey: string
  ): Promise<number | undefined> {
    return this.dmStore.getLastPromptedPeerDuration(partnerPubkey);
  }

  /**
   * Record that we've prompted the user about `seconds` so the same duration
   * doesn't re-prompt until the peer changes again. Used by the No handler —
   * keeps our outgoing setting untouched but silences future prompts for
   * this duration.
   */
  public async setLastPromptedPeerDuration(
    partnerPubkey: string,
    seconds: number
  ): Promise<void> {
    await this.dmStore.setLastPromptedPeerDuration(partnerPubkey, seconds);
  }

  /**
   * Delete every pending incoming message with the given peer-duration.
   * Called from the No handler — recipient explicitly rejected this
   * duration, so all un-accepted messages with it are dropped locally.
   */
  public async deletePendingMessagesByDuration(
    partnerPubkey: string,
    duration: number
  ): Promise<number> {
    const deleted = await this.dmStore.deletePendingMessagesByDuration(
      partnerPubkey,
      duration
    );
    if (deleted > 0) {
      this.eventBus.emit('dm:messages-expired', {
        partnerPubkey,
        count: deleted,
      });
    }
    return deleted;
  }

  /**
   * Soft-delete a conversation locally (hidden from lists, messages filtered).
   * A future newer message resurrects it. Relays are NOT touched (NIP-17 wraps
   * can't be deleted — see docs/todos/dm-incremental-sync.md).
   */
  public async deleteConversation(partnerPubkey: string): Promise<void> {
    await this.dmStore.softDeleteConversation(partnerPubkey);
    this.eventBus.emit('dm:badge-update');
  }

  /**
   * Hard-delete a conversation AND mute the sender (privately). Used for spam:
   * purges local messages and adds the pubkey to the mute list, so it stays
   * excluded from every tab even if the sender messages again.
   */
  public async deleteAndMute(partnerPubkey: string): Promise<void> {
    await this.dmStore.purgeConversation(partnerPubkey);
    muteUser(partnerPubkey, true); // private mute — emits 'mute:updated'
    this.eventBus.emit('dm:badge-update');
  }

  /**
   * Get unread counts split by known (followed) and unknown users
   * Excludes muted users from counts
   */
  public async getUnreadCountsSplit(): Promise<{
    known: number;
    unknown: number;
    total: number;
  }> {
    await this.followCheckService.init();
    await this.loadMutedPubkeys();

    const conversations = await this.dmStore.getConversations();
    let known = 0;
    let unknown = 0;

    for (const conv of conversations) {
      // Skip muted users
      if (this.isMutedSync(conv.pubkey)) {
        continue;
      }

      if (conv.unreadCount > 0) {
        if (this.followCheckService.isFollowingSync(conv.pubkey)) {
          known += conv.unreadCount;
        } else {
          unknown += conv.unreadCount;
        }
      }
    }

    return { known, unknown, total: known + unknown };
  }

  /**
   * Get conversations split by known/unknown status
   * Excludes muted users
   * @param filter - 'known' | 'unknown' | 'all'
   */
  public async getConversationsFiltered(
    filter: 'known' | 'unknown' | 'all',
    limit?: number,
    offset: number = 0
  ): Promise<DMConversation[]> {
    await this.followCheckService.init();
    await this.loadMutedPubkeys();

    // Get all conversations first
    const allConversations = await this.dmStore.getConversations();

    // Filter out muted users first, then by known/unknown
    let filtered: DMConversation[];
    if (filter === 'all') {
      filtered = allConversations.filter(c => !this.isMutedSync(c.pubkey));
    } else if (filter === 'known') {
      filtered = allConversations.filter(
        c =>
          !this.isMutedSync(c.pubkey) &&
          this.followCheckService.isFollowingSync(c.pubkey)
      );
    } else {
      filtered = allConversations.filter(
        c =>
          !this.isMutedSync(c.pubkey) &&
          !this.followCheckService.isFollowingSync(c.pubkey)
      );
    }

    // Apply offset and limit
    if (offset > 0) {
      filtered = filtered.slice(offset);
    }
    if (limit !== undefined) {
      filtered = filtered.slice(0, limit);
    }

    return filtered;
  }

  /**
   * Check if a pubkey is a known (followed) user
   */
  public async isKnownUser(pubkey: string): Promise<boolean> {
    return this.followCheckService.isFollowing(pubkey);
  }

  /**
   * Clear all DM data (for logout)
   */
  public async clear(): Promise<void> {
    await this.dmStore.clear();
    this.followCheckService.clear();
    this.mutedPubkeys.clear();
    this.mutedPubkeysLoaded = false;
    // Notify UI to update badge (will hide since no user/data)
    this.eventBus.emit('dm:badge-update');
  }

  /**
   * Load muted pubkeys into cache
   */
  private async loadMutedPubkeys(): Promise<void> {
    if (this.mutedPubkeysLoaded) return;

    try {
      const browserItems = this.muteOrchestrator.getBrowserItems();
      this.mutedPubkeys.clear();

      for (const item of browserItems) {
        if (item.type === 'user') {
          this.mutedPubkeys.add(item.id);
        }
      }

      this.mutedPubkeysLoaded = true;
    } catch (error) {
      this.systemLogger.error(
        'DMService',
        'Failed to load muted pubkeys:',
        error
      );
    }
  }

  /**
   * Refresh muted pubkeys cache (called on mute:updated event)
   */
  private async refreshMutedPubkeys(): Promise<void> {
    this.mutedPubkeysLoaded = false;
    await this.loadMutedPubkeys();
  }

  /**
   * Check if a pubkey is muted (sync, uses cache)
   */
  private isMutedSync(pubkey: string): boolean {
    return this.mutedPubkeys.has(pubkey);
  }
}
