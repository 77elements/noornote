/**
 * User Profile Service (also exported as ProfileService)
 * Resolves user pubkeys to usernames, profile pictures, and metadata
 * Uses ProfileOrchestrator for fetching
 *
 * ── Profile-Discovery in NoorNote — die Anlaufstellen-Karte ────────────────
 * Wer macht was (Read-Pfad):
 *   • THIS SERVICE — the single hub. LRU cache + in-flight dedup + retry
 *     cooldown + pubsub. All consumers (61 call sites) go through
 *     getUserProfile / getUserProfiles / getDisplayName / getDisplayPicture /
 *     subscribeToProfile.
 *     Self-healing (since 2026-11-14): a subscribed-but-unresolved pubkey is
 *     re-fetched automatically — bounded retry timers (max 3 attempts) plus a
 *     `relay:connected` sweep that pre-empts pending retries. This closes the
 *     mobile cold-start race where the first fetch wave ran against a
 *     not-yet-connected relay pool and headers stayed "@npub…"/"Anonymous"
 *     forever (timeout misses get an 8s cooldown instead of 30s).
 *   • ProfileOrchestrator — relay fetch only (2-stage: aggregator batch →
 *     author outbound recovery). No caching of its own.
 *   • MentionProfileCache — autocomplete preloader layered ON TOP of this
 *     service (no duplicate cache); expires with its suggestions list.
 *   • ContentProcessor.getNonBlockingProfile() — synchronous render read
 *     from this service's cache (delegates, never fetches itself).
 * Anti-patterns (enforced by review):
 *   ✗ Direct kind:0 fetches anywhere else (bypasses cache + cooldown →
 *     duplicate relay traffic and flicker). Historically: ZapService's
 *     write-relay fallback — since rerouted through ProfileOrchestrator.
 *     (NOT a bypass: SearchOrchestrator.searchProfiles — NIP-50 full-text
 *     search over kind:0 is a different query type, not a pubkey lookup.)
 *   ✗ Caching name-less placeholders (poisons displays with "@npub…" —
 *     see getUserProfile miss handling).
 *   ✗ Broadcasting name-less entries to subscribers (downgrade flicker —
 *     see getUserProfiles stage 1 guard).
 * Write path: ProfileEditorService publishes kind:0 and feeds
 * setCachedProfile(); invalidateProfile() drops a stale entry.
 * Persistence (since 2026-08-22): display-bearing cache writes are mirrored
 * (debounced batch) into ProfileStore — per-account IndexedDB
 * `noornote-profiles-{npub}` — and warmFromStore() refills the LRU at login
 * (PostLoginService) so cold starts render names instantly. Never persisted:
 * name-less placeholders. Account switch clears memory only (per-account DB
 * naming isolates); Settings "clear cache" wipes via wipePersisted().
 * ───────────────────────────────────────────────────────────────────────────
 *
 * LRU CACHE STRATEGY:
 * - Memory-only LRU cache (via LRUCache helper)
 * - Platform-aware size: Desktop > Web > Mobile
 * - Fresh on every app start
 */

import { ProfileOrchestrator } from './orchestration/ProfileOrchestrator';
import { LRUCache, getCacheSize } from '../helpers/LRUCache';
import { getAvatarFallback } from '../helpers/avatarFallback';
import { hexToNpub } from '../helpers/nip19';
import { profileStore } from './ProfileStore';
import { AuthService } from './AuthService';
import { TypedEventBus } from '../core/TypedEventBus';

/** A profile is worth persisting/restoring only when it carries display data. */
const hasDisplayData = (p: UserProfile): boolean =>
  !!(p.name || p.display_name || p.username || p.picture);

/** Same test, null-safe — for probing the cache without a placeholder dance. */
const hasRealProfile = (p: UserProfile | null | undefined): boolean =>
  !!p && hasDisplayData(p);

/** Debounce window for batched ProfileStore writes (ms). */
const PERSIST_DEBOUNCE_MS = 2000;

/** Per-pubkey failure record: when it failed and how long to back off. */
interface FailedFetch {
  ts: number;
  cooldown: number;
}

export interface UserProfile {
  pubkey: string;
  name?: string;
  display_name?: string;
  username?: string;
  picture?: string;
  about?: string;
  nip05?: string;
  nip05s?: string[]; // Multiple NIP-05 addresses from tags (Animestr-style)
  verified?: boolean;
  lud06?: string;
  lud16?: string;
  website?: string;
  banner?: string;
  lastUpdated?: number;
}

export class UserProfileService {
  private static instance: UserProfileService;

  /** LRU Cache for profiles (platform-aware size) */
  private profileCache = new LRUCache<UserProfile>(
    getCacheSize(2000, 1000, 500)
  );

  private orchestrator: ProfileOrchestrator;
  private fetchingProfiles: Map<
    string,
    Promise<{ profile: UserProfile | null; timedOut: boolean }>
  > = new Map();
  private profileUpdateCallbacks: Map<
    string,
    Set<(profile: UserProfile) => void>
  > = new Map();
  /** Listeners that want to be notified for EVERY profile update (any pubkey). */
  private anyProfileUpdateCallbacks: Set<
    (pubkey: string, profile: UserProfile) => void
  > = new Set();

  /** Track failed fetches to prevent rapid retry storms (pubkey → failure) */
  private failedFetches: Map<string, FailedFetch> = new Map();
  private readonly FAILED_FETCH_COOLDOWN = 30000; // 30s — throttle retries for a missing profile without poisoning the cache
  /** A TIMEOUT is not "not found" — the NDK subscription keeps running and
   *  relays (esp. on slow mobile cold starts) may still answer. Short window. */
  private readonly TIMEOUT_FETCH_COOLDOWN = 8000;
  private readonly FAILED_FETCH_MAX_ENTRIES = 500; // cap — drop oldest beyond this

  /** Max automatic re-fetch attempts for a subscribed-but-unresolved pubkey
   *  (the mobile cold-start case: first fetch ran before relays connected). */
  private static readonly MAX_RESOLVE_ATTEMPTS = 3;
  /** Connectivity sweep debounce — let more relays connect before probing. */
  private static readonly SWEEP_DEBOUNCE_MS = 2000;
  /** pubkey → pending retry timer (subscribe-retry loop). */
  private resolveTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** pubkey → retry attempts spent (reset on real resolve / unsubscribe). */
  private resolveAttempts: Map<string, number> = new Map();
  /** Connectivity sweep debounce flag. */
  private sweepScheduled = false;

  /**
   * Record a failed-fetch cooldown, evicting the oldest entry when the cap
   * is reached so long sessions on npub-heavy feeds can't grow the map forever.
   * A timeout failure gets a SHORT cooldown: the fetch window expired while
   * relays were still connecting/answering — not proof the profile is absent.
   */
  private recordFailedFetch(pubkey: string, cooldownOverrideMs?: number): void {
    if (
      this.failedFetches.size >= this.FAILED_FETCH_MAX_ENTRIES &&
      !this.failedFetches.has(pubkey)
    ) {
      let oldestKey: string | null = null;
      let oldestTs = Infinity;
      for (const [key, failure] of this.failedFetches) {
        if (failure.ts < oldestTs) {
          oldestTs = failure.ts;
          oldestKey = key;
        }
      }
      if (oldestKey !== null) this.failedFetches.delete(oldestKey);
    }
    this.failedFetches.set(pubkey, {
      ts: Date.now(),
      cooldown: cooldownOverrideMs ?? this.FAILED_FETCH_COOLDOWN,
    });
  }

  /** Debounced ProfileStore writes: dirty pubkeys + flush timer. */
  private dirtyProfiles = new Map<string, UserProfile>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** Account (npub) whose store has been warmed this session; null = not warmed. */
  private warmedNpub: string | null = null;

  private constructor() {
    this.orchestrator = ProfileOrchestrator.getInstance();
    // Connectivity-aware recovery: fetches that failed before the relay pool
    // was actually connected (mobile cold start) get re-armed once a relay
    // really connects — the old failure's cooldown premise is void then.
    // Singleton-lifetime subscription (never off'd — the service lives forever).
    TypedEventBus.getInstance().on('relay:connected', () =>
      this.scheduleConnectivitySweep()
    );
  }

  public static getInstance(): UserProfileService {
    if (!UserProfileService.instance) {
      UserProfileService.instance = new UserProfileService();
    }
    return UserProfileService.instance;
  }

  /**
   * Get username ONLY (lightweight, fast)
   * Returns cached username or null if not yet loaded.
   * For rendering use getDisplayName() — it always returns a usable string.
   */
  public getUsername(pubkey: string): string | null {
    const cached = this.profileCache.get(pubkey);
    if (cached) {
      return cached.display_name || cached.name || cached.username || null;
    }
    return null;
  }

  /**
   * Get profile picture ONLY (lightweight, fast)
   * Returns cached picture URL or null if not yet loaded.
   * For rendering use getDisplayPicture() — it always returns a usable URL.
   */
  public getProfilePicture(pubkey: string): string | null {
    const cached = this.profileCache.get(pubkey);
    return cached?.picture || null;
  }

  /**
   * Render-ready name: real cached name, or a shortened npub fallback so the
   * UI never has to invent its own placeholder. Triggers a background fetch
   * on cache miss; subscribers will be updated when the real name arrives.
   */
  public getDisplayName(pubkey: string): string {
    return UserProfileService.displayNameOf(
      this.profileCache.get(pubkey) ?? null,
      pubkey
    );
  }

  /**
   * Render-ready picture URL: real cached picture, or a deterministic identicon
   * so the UI never has to render an empty <img>. Same cache-miss semantics as
   * getDisplayName().
   */
  public getDisplayPicture(pubkey: string): string {
    return UserProfileService.displayPictureOf(
      this.profileCache.get(pubkey) ?? null,
      pubkey
    );
  }

  /**
   * Extract render-ready name from a profile object (e.g. inside a
   * subscribeToProfile callback). Always returns a usable string.
   */
  public static displayNameOf(
    profile: UserProfile | null,
    pubkey: string
  ): string {
    const real = profile?.display_name || profile?.name || profile?.username;
    if (real) return real;
    const npub = hexToNpub(pubkey);
    return npub ? `@${npub.slice(0, 12)}…` : pubkey.slice(0, 8);
  }

  /**
   * Extract render-ready picture from a profile object. Always returns a
   * usable URL (real or identicon).
   */
  public static displayPictureOf(
    profile: UserProfile | null,
    pubkey: string
  ): string {
    return profile?.picture || getAvatarFallback(pubkey);
  }

  /**
   * Check if profile is cached (without fetching)
   */
  public hasProfile(pubkey: string): boolean {
    return this.profileCache.has(pubkey);
  }

  /**
   * Get cached profile (without fetching)
   */
  public getCachedProfile(pubkey: string): UserProfile | null {
    return this.profileCache.get(pubkey) ?? null;
  }

  /**
   * Get full user profile
   * Returns cached profile or fetches from relays
   */
  public async getUserProfile(
    pubkey: string,
    relayHints?: string[]
  ): Promise<UserProfile> {
    // Check cache first (LRU touch handled by LRUCache.get())
    const cached = this.profileCache.get(pubkey);
    if (cached) {
      return cached;
    }

    // Persistent store stage (per-account IndexedDB, single-key read): a
    // profile persisted in ANY previous session resolves in milliseconds —
    // without waiting for relay sockets to connect. This closes the cold-
    // start race where early renders (thread context, note headers) miss the
    // still-empty LRU and would otherwise block on the relay boot for seconds.
    // Same memory → IndexedDB → network order as the event fetch path. Runs
    // BEFORE the in-flight dedup check: an already-running relay fetch must
    // not hold us up when the store already has the answer.
    const fromStore = await profileStore.get(pubkey);
    if (fromStore) {
      this.cacheProfile(pubkey, fromStore, { notify: false });
      return fromStore;
    }

    // Deduplication: if already fetching, wait for that request
    if (this.fetchingProfiles.has(pubkey)) {
      const { profile } = await this.fetchingProfiles.get(pubkey)!;
      return profile ?? this.getDefaultProfile(pubkey);
    }

    // Check if recently failed - return default profile during cooldown. A
    // caller-provided relay hint is a fresh source we may not have tried yet, so
    // it bypasses the cooldown (without a hint the cooldown behaves as before).
    const failure = this.failedFetches.get(pubkey);
    if (
      !relayHints?.length &&
      failure &&
      Date.now() - failure.ts < failure.cooldown
    ) {
      return this.getDefaultProfile(pubkey);
    }

    // Start new fetch
    const fetchPromise = this.fetchProfileFromRelays(pubkey, relayHints);
    this.fetchingProfiles.set(pubkey, fetchPromise);

    try {
      const { profile, timedOut } = await fetchPromise;

      if (profile) {
        // Real profile found — cache it and clear any prior failure.
        this.failedFetches.delete(pubkey);
        this.cacheProfile(pubkey, profile, { notify: true });
        return profile;
      }

      // Miss (both relay stages came back empty). Do NOT cache an empty
      // placeholder and do NOT broadcast it to subscribers. Broadcasting a
      // name-less fallback would downgrade already-resolved displays (note
      // headers, mention chips, repost headers) back to "@npub…", causing
      // the exact flicker the app must never show. Only record a cooldown so
      // renders are throttled, and return the fallback to the direct caller
      // (their own Promise chain) — subscribers that already have real data
      // keep it untouched. A TIMEOUT gets a shorter cooldown: the fetch
      // window expired while relays were still answering (slow mobile cold
      // start), which is not proof the profile is absent — the retry loop
      // below re-arms quickly.
      this.recordFailedFetch(
        pubkey,
        timedOut ? this.TIMEOUT_FETCH_COOLDOWN : undefined
      );
      return this.getDefaultProfile(pubkey);
    } catch (error) {
      console.debug(`Failed to fetch profile for ${pubkey}:`, error);
      // Record failure timestamp to prevent rapid retries
      this.recordFailedFetch(pubkey);
      return this.getDefaultProfile(pubkey);
    } finally {
      this.fetchingProfiles.delete(pubkey);
    }
  }

  /**
   * Check if user is verified (has valid NIP-05)
   */
  public isVerified(profile: UserProfile): boolean {
    return profile.verified === true && !!profile.nip05;
  }

  /**
   * Fetch multiple user profiles efficiently
   */
  public async getUserProfiles(
    pubkeys: string[]
  ): Promise<Map<string, UserProfile>> {
    const result = new Map<string, UserProfile>();
    const toFetch: string[] = [];

    // Check cache first
    for (const pubkey of pubkeys) {
      const cached = this.profileCache.get(pubkey);
      if (cached) {
        result.set(pubkey, cached);
      } else {
        toFetch.push(pubkey);
      }
    }

    // Fetch missing profiles
    if (toFetch.length > 0) {
      // Stage 1 — aggregator batch (fast, covers the vast majority).
      try {
        const fetchedProfiles =
          await this.fetchMultipleProfilesFromRelays(toFetch);
        fetchedProfiles.forEach((profile, pubkey) => {
          // 'display-only': broadcasting a name-less entry (e.g. an empty
          // kind:0) would downgrade already-resolved displays back to the
          // npub fallback — notify only entries carrying display data.
          this.cacheProfile(pubkey, profile, { notify: 'display-only' });
          result.set(pubkey, profile);
        });
      } catch (error) {
        console.debug(
          'Failed to fetch user profiles (aggregator batch):',
          error
        );
      }

      // Stage 2 — outbound recovery for the long tail. A user who
      // published their kind:0 only to their own NIP-65 write-relay
      // (e.g. the Private-Relay-Sovereignty case) won't show up in the
      // aggregator batch. Retry each miss via `ProfileOrchestrator.
      // fetchProfile`, which does its own 2-stage aggregator-then-
      // outbound fetch. Bounded parallelism keeps the WebSocket pool
      // safe; RECOVERY_CAP keeps the total cost predictable even when
      // a viewing context (e.g. a 500-member Tribes list) has many
      // misses.
      const stillMissing = toFetch.filter(pk => !result.has(pk));
      if (stillMissing.length > 0) {
        const RECOVERY_CAP = 20;
        const CONCURRENCY = 4;
        const slice = stillMissing.slice(0, RECOVERY_CAP);
        for (let i = 0; i < slice.length; i += CONCURRENCY) {
          const batch = slice.slice(i, i + CONCURRENCY);
          await Promise.all(
            batch.map(async pubkey => {
              try {
                const { profile, timedOut } =
                  await this.orchestrator.fetchProfileWithMeta(pubkey);
                if (profile) {
                  const userProfile = profile as UserProfile;
                  this.cacheProfile(pubkey, userProfile, { notify: true });
                  result.set(pubkey, userProfile);
                } else {
                  // Full 2-stage attempt (aggregator + outbound) came back
                  // empty — record the retry cooldown exactly like the
                  // single-fetch path, so repeat renders don't re-hammer
                  // the relays for a profile that is genuinely unfindable.
                  // A timeout gets the short window (relays may still answer).
                  this.recordFailedFetch(
                    pubkey,
                    timedOut ? this.TIMEOUT_FETCH_COOLDOWN : undefined
                  );
                }
              } catch {
                // Transport-level failure — also a spent attempt, cooldown applies.
                this.recordFailedFetch(pubkey);
              }
            })
          );
        }
      }

      // Fill remaining misses with a default profile so callers always
      // get a non-null entry per requested pubkey. These placeholders are
      // returned to the caller ONLY — they never enter the cache, and
      // misses beyond the recovery cap stay cooldown-free so per-identity
      // fetches (UserIdentity, mention chips) can still resolve them.
      toFetch.forEach(pubkey => {
        if (!result.has(pubkey)) {
          result.set(pubkey, this.getDefaultProfile(pubkey));
        }
      });
    }

    return result;
  }

  /**
   * Fetch single profile from relays (via ProfileOrchestrator)
   */
  private async fetchProfileFromRelays(
    pubkey: string,
    relayHints?: string[]
  ): Promise<{ profile: UserProfile | null; timedOut: boolean }> {
    // null = orchestrator found nothing on any relay (miss/timeout). The caller
    // (getUserProfile) turns that into a throttled, NON-cached fallback so a
    // transient miss never permanently poisons the cache with an empty profile.
    // `timedOut` distinguishes an expired fetch window (relays may still
    // answer — retry sooner) from a clean relay-side "not found".
    const { profile, timedOut } = await this.orchestrator.fetchProfileWithMeta(
      pubkey,
      relayHints
    );
    return { profile: profile ? (profile as UserProfile) : null, timedOut };
  }

  /**
   * Fetch multiple profiles efficiently (via ProfileOrchestrator)
   * Returns ONLY real relay hits — misses are deliberately absent so the
   * caller can run its stage-2 recovery and cooldown bookkeeping. Filling
   * misses with fabricated name-less defaults here would poison the LRU
   * cache for the whole session (the "@npub1…" / "Anonymous" bug).
   */
  private async fetchMultipleProfilesFromRelays(
    pubkeys: string[]
  ): Promise<Map<string, UserProfile>> {
    const profiles = await this.orchestrator.fetchMultipleProfiles(pubkeys);

    const result = new Map<string, UserProfile>();
    profiles.forEach((profile, pubkey) => {
      result.set(pubkey, profile as UserProfile);
    });

    return result;
  }

  /**
   * Create default profile for a pubkey
   */
  private getDefaultProfile(pubkey: string): UserProfile {
    return {
      pubkey,
      lastUpdated: Date.now(),
    };
  }

  /**
   * Subscribe to profile updates (like nostr-react useProfile pattern)
   */
  public subscribeToProfile(
    pubkey: string,
    callback: (profile: UserProfile) => void,
    relayHints?: string[]
  ): () => void {
    if (!this.profileUpdateCallbacks.has(pubkey)) {
      this.profileUpdateCallbacks.set(pubkey, new Set());
    }

    this.profileUpdateCallbacks.get(pubkey)!.add(callback);

    // Check cache first, fetch only if not cached
    const cached = this.profileCache.get(pubkey);
    if (cached) {
      // Immediate callback with cached data
      callback(cached);
    } else {
      // Fetch from relays (relayHints, when provided, are tried first).
      // If the fetch comes back name-less (relay miss or cold-start timeout),
      // schedule bounded retries — on slow mobile connections the first
      // attempt regularly runs before the relay pool is connected, and
      // without a retry the header stays "@npub…" / "Anonymous" forever.
      this.getUserProfile(pubkey, relayHints)
        .then(profile => {
          callback(profile);
          if (!hasDisplayData(profile)) {
            this.scheduleResolveRetry(pubkey);
          }
        })
        .catch(() => {
          this.scheduleResolveRetry(pubkey);
        });
    }

    // Return unsubscribe function
    return () => {
      const callbacks = this.profileUpdateCallbacks.get(pubkey);
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          this.profileUpdateCallbacks.delete(pubkey);
          // Last subscriber gone — no one needs the retry loop anymore.
          this.cancelResolveRetry(pubkey);
        }
      }
    };
  }

  /**
   * Bounded self-healing retry for a subscribed-but-unresolved pubkey: one
   * re-fetch per cooldown window, at most MAX_RESOLVE_ATTEMPTS. Success (a
   * display-bearing profile entering the cache) resets the attempt counter
   * and updates ALL subscribers via notifyProfileUpdate — the rendered
   * headers patch themselves, no component code needed.
   */
  private scheduleResolveRetry(pubkey: string): void {
    if (this.resolveTimers.has(pubkey)) return; // retry already armed
    const attempt = (this.resolveAttempts.get(pubkey) ?? 0) + 1;
    if (attempt > UserProfileService.MAX_RESOLVE_ATTEMPTS) return;
    this.resolveAttempts.set(pubkey, attempt);
    // Wait out the recorded cooldown (timeout failures back off shorter) so
    // the retry is not bounced by the cooldown check inside getUserProfile.
    const failure = this.failedFetches.get(pubkey);
    const delay = failure ? failure.cooldown + 1000 : 1000;
    const timer = setTimeout(() => {
      this.resolveTimers.delete(pubkey);
      void this.retryResolve(pubkey);
    }, delay);
    this.resolveTimers.set(pubkey, timer);
  }

  /** One retry step: fetch again if the pubkey is still wanted + unresolved. */
  private async retryResolve(pubkey: string): Promise<void> {
    if (!this.profileUpdateCallbacks.get(pubkey)?.size) {
      this.resolveAttempts.delete(pubkey); // subscribers gone — stop caring
      return;
    }
    if (hasRealProfile(this.profileCache.get(pubkey))) {
      // Resolved in the meantime (batch fetch, warm, setCachedProfile).
      this.resolveAttempts.delete(pubkey);
      return;
    }
    try {
      const profile = await this.getUserProfile(pubkey);
      if (hasDisplayData(profile)) {
        this.resolveAttempts.delete(pubkey); // resolved — reset the counter
      } else {
        this.scheduleResolveRetry(pubkey); // next attempt (bounded)
      }
    } catch {
      this.scheduleResolveRetry(pubkey);
    }
  }

  /** Stop the retry loop for a pubkey (unsubscribe / account switch). */
  private cancelResolveRetry(pubkey: string): void {
    const timer = this.resolveTimers.get(pubkey);
    if (timer) {
      clearTimeout(timer);
      this.resolveTimers.delete(pubkey);
    }
    this.resolveAttempts.delete(pubkey);
  }

  /**
   * Connectivity sweep: after a relay (re)connects, re-arm every subscribed
   * pubkey that is still unresolved. This is the mobile cold-start fix —
   * the first fetch wave ran against a not-yet-connected pool; now that the
   * network is real, those profiles are fetchable. Debounced so a connect
   * burst produces one sweep, not one per relay.
   */
  private scheduleConnectivitySweep(): void {
    if (this.sweepScheduled) return;
    this.sweepScheduled = true;
    setTimeout(() => {
      this.sweepScheduled = false;
      this.sweepPendingResolves();
    }, UserProfileService.SWEEP_DEBOUNCE_MS);
  }

  private sweepPendingResolves(): void {
    for (const pubkey of Array.from(this.resolveAttempts.keys())) {
      if (this.fetchingProfiles.has(pubkey)) continue; // fetch in flight
      if (!this.profileUpdateCallbacks.get(pubkey)?.size) {
        this.resolveAttempts.delete(pubkey); // nobody listening anymore
        continue;
      }
      if (hasRealProfile(this.profileCache.get(pubkey))) {
        this.resolveAttempts.delete(pubkey); // resolved in the meantime
        continue;
      }
      const attempt = this.resolveAttempts.get(pubkey) ?? 0;
      if (attempt >= UserProfileService.MAX_RESOLVE_ATTEMPTS) continue;
      this.resolveAttempts.set(pubkey, attempt + 1);
      // Pre-empt any armed retry timer: its delay was sized to outlast the
      // old cooldown, and that cooldown's premise (network state) is void now.
      const timer = this.resolveTimers.get(pubkey);
      if (timer) {
        clearTimeout(timer);
        this.resolveTimers.delete(pubkey);
      }
      // The network state changed — the old failure's cooldown premise is
      // void, so clear it and probe immediately.
      this.failedFetches.delete(pubkey);
      void this.getUserProfile(pubkey)
        .then(profile => {
          if (!hasDisplayData(profile)) this.scheduleResolveRetry(pubkey);
        })
        .catch(() => this.scheduleResolveRetry(pubkey));
    }
  }

  /**
   * Notify all subscribers when profile updates
   */
  private notifyProfileUpdate(pubkey: string, profile: UserProfile): void {
    const callbacks = this.profileUpdateCallbacks.get(pubkey);
    if (callbacks) {
      callbacks.forEach(callback => callback(profile));
    }
    this.anyProfileUpdateCallbacks.forEach(cb => cb(pubkey, profile));
  }

  /**
   * Subscribe to ALL profile updates (any pubkey). Use for cross-cutting consumers
   * like mention-chip DOM patchers that don't know in advance which pubkeys will
   * appear. Returns an unsubscribe function.
   */
  public subscribeToAnyProfileUpdate(
    callback: (pubkey: string, profile: UserProfile) => void
  ): () => void {
    this.anyProfileUpdateCallbacks.add(callback);
    return () => {
      this.anyProfileUpdateCallbacks.delete(callback);
    };
  }

  /**
   * Manually set a profile in cache (e.g., after onboarding publish)
   */
  public setCachedProfile(pubkey: string, profile: UserProfile): void {
    this.cacheProfile(pubkey, profile, { notify: true });
  }

  /**
   * Single funnel for every cache write: LRU set + optional subscriber
   * notify + gated persistence into ProfileStore (display-bearing entries
   * only, debounced batch write).
   *
   * notify: true          → always broadcast (fetch results, explicit sets)
   * notify: 'display-only' → broadcast only entries carrying display data
   *                         (batch path: a name-less broadcast downgrades
   *                         already-resolved displays — the npub-flicker bug)
   */
  private cacheProfile(
    pubkey: string,
    profile: UserProfile,
    opts: { notify?: boolean | 'display-only' } = {}
  ): void {
    this.profileCache.set(pubkey, profile);
    if (hasDisplayData(profile)) {
      // Real data landed — the resolve-retry loop for this pubkey is done.
      this.resolveAttempts.delete(pubkey);
    }
    if (opts.notify === true) {
      this.notifyProfileUpdate(pubkey, profile);
    } else if (opts.notify === 'display-only' && hasDisplayData(profile)) {
      this.notifyProfileUpdate(pubkey, profile);
    }
    if (hasDisplayData(profile)) this.schedulePersist(pubkey, profile);
  }

  /** Debounced batch write into ProfileStore. Non-display entries are never
   *  queued (persisting placeholders is the cache-poisoning bug). */
  private schedulePersist(pubkey: string, profile: UserProfile): void {
    this.dirtyProfiles.set(pubkey, profile);
    if (this.persistTimer !== null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      const batch = this.dirtyProfiles;
      this.dirtyProfiles = new Map();
      void profileStore.saveMany(batch);
    }, PERSIST_DEBOUNCE_MS);
  }

  /**
   * Warm the LRU from the per-account ProfileStore (IndexedDB). Called once
   * per account after login (PostLoginService). Restored entries carrying
   * display data notify subscribers so already-rendered fallbacks
   * (@npub… / identicons) patch to the real name/picture immediately.
   *
   * Idempotent per account; re-runs after clearCache() (account switch).
   */
  public async warmFromStore(): Promise<void> {
    const npub = AuthService.getInstance().getCurrentUser()?.npub;
    if (!npub || this.warmedNpub === npub) return;
    this.warmedNpub = npub;

    const stored = await profileStore.loadAll();
    if (this.warmedNpub !== npub) return; // account switched mid-warm — discard
    for (const [pubkey, profile] of stored) {
      if (this.profileCache.has(pubkey)) continue; // never overwrite fresher memory
      this.profileCache.set(pubkey, profile);
      if (hasDisplayData(profile)) this.notifyProfileUpdate(pubkey, profile);
    }
  }

  /**
   * Invalidate cached profile (e.g., after profile edit)
   */
  public invalidateProfile(pubkey: string): void {
    this.profileCache.delete(pubkey);
    this.dirtyProfiles.delete(pubkey);
    void profileStore.delete(pubkey);
  }

  /**
   * Clear all cached profiles (MEMORY only). Called on account switch
   * (CacheManager.clearUserSpecificCaches) — must NOT wipe ProfileStore:
   * per-account DB naming already isolates accounts, and at switch time the
   * store belongs to the NEWLY-current account. Use wipePersisted() for the
   * explicit Settings "clear cache" action.
   */
  public clearCache(): void {
    this.profileCache.clear();
    this.failedFetches.clear();
    this.dirtyProfiles.clear();
    // Tear down the resolve-retry state (pending timers would fire into a
    // freshly-switched account's context otherwise).
    for (const timer of this.resolveTimers.values()) clearTimeout(timer);
    this.resolveTimers.clear();
    this.resolveAttempts.clear();
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.warmedNpub = null; // re-warm for the next account
  }

  /**
   * Wipe persisted profiles (Settings "clear cache"). Explicit user intent —
   * unlike clearCache() this empties the current account's IndexedDB mirror.
   */
  public async wipePersisted(): Promise<void> {
    this.clearCache();
    await profileStore.wipePersisted();
  }

  /**
   * Get cache stats (for debugging)
   */
  public getCacheStats(): { size: number; maxSize: number } {
    return {
      size: this.profileCache.size,
      maxSize: getCacheSize(2000, 1000, 500),
    };
  }
}

/** Alias for UserProfileService (microservice naming convention) */
export const ProfileService = UserProfileService;
