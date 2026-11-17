/**
 * PostLoginService
 *
 * Orchestrates all post-login initialization:
 * - Navigation decision (setup wizard vs timeline)
 * - Account switch detection + cache clearing
 * - Parallel startup of background services
 */

import { Router } from './Router';
import { AppState } from './AppState';
import { TypedEventBus } from '../core/TypedEventBus';
import { ViewMountingService } from './ViewMountingService';
import { isFocusUiEnabled } from '../helpers/focusUiSetting';

export class PostLoginService {
  private static instance: PostLoginService;

  private router = Router.getInstance();
  private appState = AppState.getInstance();
  private viewMountingService = ViewMountingService.getInstance();
  /**
   * Event-bus subscription for the runtime v2↔v1 interface switch. The
   * v2 background gates (article polling, mention-profile preload) are
   * evaluated at login — a mid-session switch must re-apply them in BOTH
   * directions, otherwise v1 keeps polling under v2 (wasted relay load)
   * or classic mode misses its services after switching back. Registered
   * once (idempotent), survives account switches.
   */
  private focusUiToggleSubscriptionId: string | null = null;

  /**
   * Pubkey of the account that handleLogin is currently running for (or has
   * completed for). Set synchronously before any await so concurrent calls
   * for the same pubkey are blocked immediately. Cleared by resetLoginState()
   * on logout so a fresh login for the same account works.
   */
  private loggedInPubkey: string | null = null;

  private constructor() {}

  public static getInstance(): PostLoginService {
    if (!PostLoginService.instance) {
      PostLoginService.instance = new PostLoginService();
    }
    return PostLoginService.instance;
  }

  public async handleLogin(data: {
    npub: string;
    pubkey: string;
  }): Promise<void> {
    // Idempotency: block concurrent or sequential duplicate calls for the same
    // pubkey. Two callers fire on session restore — the user:login event
    // listener (App.ts:425) and the explicit boot-path fallback (App.ts:189,
    // needed when auth initialization times out before user:login emits).
    // Both call handleLogin within the same tick; without this guard every
    // post-login service (DM, notifications, follow list) starts twice.
    if (this.loggedInPubkey === data.pubkey) return;
    this.loggedInPubkey = data.pubkey;

    try {
      // Logged-out CTA stash: when the user came in through a "logged out"
      // modal (e.g. on a public note/profile/article) and just authenticated,
      // jump to the action-specific destination (DM thread, etc.) via a full
      // reload so App.ts's boot path sees the fresh logged-in state.
      const redirect = sessionStorage.getItem('noornote_post_login_redirect');
      if (redirect) {
        sessionStorage.removeItem('noornote_post_login_redirect');
        window.location.href = redirect;
        return;
      }

      const currentPath = this.router.getCurrentPath();
      const lastURL = this.router.getLastURL();

      // Navigate to home/setup only if user just manually logged in
      if (currentPath === '/login' && (!lastURL || lastURL === '/login')) {
        const { PerAccountLocalStorage, StorageKeys } = await import(
          './PerAccountLocalStorage'
        );
        const storage = PerAccountLocalStorage.getInstance();
        const needsSetup = storage.getForPubkey<boolean>(
          StorageKeys.NEEDS_PROFILE_SETUP,
          data.pubkey,
          false
        );

        this.router.navigate(needsSetup ? '/setup' : '/');
      }

      // Detect account switch and clear stale caches
      const lastLoggedInPubkey = localStorage.getItem(
        'noornote_last_logged_in_pubkey'
      );
      if (lastLoggedInPubkey && lastLoggedInPubkey !== data.pubkey) {
        // Stale per-account IndexedDB-Verbindungen (NoorDB-Registry) schließen,
        // bevor irgendein Service des neuen Accounts eigene öffnet.
        const { closeAllPerAccountDatabases } = await import(
          './persistence/NoorDB'
        );
        closeAllPerAccountDatabases();

        const { CacheManager } = await import('./CacheManager');
        CacheManager.getInstance().clearUserSpecificCaches();

        this.viewMountingService.destroyTimelineCache();
        if (currentPath === '/' || currentPath === '/timeline') {
          void this.viewMountingService.mountView('timeline');
        }
      }
      localStorage.setItem('noornote_last_logged_in_pubkey', data.pubkey);

      // Start all post-login services in parallel
      await Promise.all([
        this.loadFollowList(data.pubkey),
        // Warm the profile LRU from the per-account ProfileStore so the first
        // renders show names/pictures instead of @npub fallbacks. Runs before
        // the timeline mounts in practice (IDB read of ~1-2k entries is fast).
        this.startService('profile store warm-up', async () => {
          const { UserProfileService } = await import('./UserProfileService');
          await UserProfileService.getInstance().warmFromStore();
        }),
        this.startService('notifications', async () => {
          const { NotificationsOrchestrator } = await import(
            './orchestration/NotificationsOrchestrator'
          );
          await NotificationsOrchestrator.getInstance().start();
          // Focus UI (v2): no background article fetching — the Articles
          // object fetches when the user opens it. (Notifications itself
          // stays: it drives the notifications diode.) The switch bridge
          // below re-applies this on every interface toggle.
          this.syncBackgroundFetchGate();
        }),
        // hashtag-subscriptions is managed by AddonLoader via the user:login event.
        // Its runtime calls service.startPolling() — no explicit bootstrap here.
        // profile-recognition is managed by AddonLoader via the user:login event.
        // Its runtime calls service.init() as part of the addon lifecycle —
        // no explicit bootstrap needed here anymore.
        this.startService('DM service', async () => {
          const { DMService } = await import('./dm/DMService');
          await DMService.getInstance().start();
        }),
      ]);

      // Initialize AutoSyncService for Easy Mode list syncing
      const { AutoSyncService } = await import('./AutoSyncService');
      const autoSync = AutoSyncService.getInstance();
      // Focus UI (v2): the v1 list auto-sync (startup fetch, 5-min
      // poller, event-driven relay pushes) is silenced — a v2 user
      // carries only the diode trio. Idempotent; the switch bridge
      // (syncBackgroundFetchGate) resumes it when returning to classic.
      if (isFocusUiEnabled()) autoSync.pauseForFocusUi();

      // Sync petnames from relays (NIP-78 encrypted, non-blocking)
      void import('./PetnameService').then(({ PetnameService }) => {
        PetnameService.getInstance()
          .syncFromRelays()
          .catch(() => {});
      });

      // Sync soft-mutes from relays (NIP-78 encrypted, non-blocking).
      // Notification-only suppression — consumed by NotificationsOrchestrator.
      void import('./SoftMuteService').then(({ SoftMuteService }) => {
        SoftMuteService.getInstance()
          .syncFromRelays()
          .catch(() => {});
      });

      // Bookmark read-state sync (unread counter) — part of the bookmark
      // diode: cross-device read markers must sync on EVERY interface (v1
      // also starts it via the sidebar managers; start() is idempotent).
      // No-op unless the bookmarks addon and its sync toggle are on.
      void import('./BookmarkReadStateService').then(
        ({ BookmarkReadStateService }) => {
          void BookmarkReadStateService.getInstance().start();
        }
      );

      // Runtime interface switch (instant, no reload): keep the v1-only
      // background fetches in sync with the active interface.
      if (!this.focusUiToggleSubscriptionId) {
        this.focusUiToggleSubscriptionId = TypedEventBus.getInstance().on(
          'settings:focus-ui-changed',
          () => this.syncBackgroundFetchGate()
        );
      }
    } catch (error) {
      // Reset so a retry (e.g. manual re-login) is not blocked by the guard.
      this.loggedInPubkey = null;
      throw error;
    }
  }

  /**
   * Clear the idempotency guard so a fresh login for the same account works
   * after logout. Called from the user:logout handler in App.ts.
   */
  public resetLoginState(): void {
    this.loggedInPubkey = null;
  }

  /**
   * Wraps a service startup function with error handling.
   * Prevents individual service failures from blocking other startups.
   */
  private async startService(
    name: string,
    fn: () => Promise<void>
  ): Promise<void> {
    try {
      await fn();
    } catch (error) {
      console.error(`[PostLoginService] Failed to start ${name}:`, error);
    }
  }

  private async loadFollowList(pubkey: string): Promise<void> {
    try {
      const { UserService } = await import('./UserService');
      const { MentionProfileCache } = await import('./MentionProfileCache');

      const followingPubkeys =
        await UserService.getInstance().getUserFollowing(pubkey);
      this.appState.setState('user', { followingPubkeys });

      // Focus UI (v2): skip the mention-profile preload (relay fetches for
      // EVERY follow) — profiles load on demand when surfaces render them.
      // The switch bridge re-applies this on every interface toggle.
      if (!isFocusUiEnabled()) {
        MentionProfileCache.getInstance()
          .preloadProfiles(followingPubkeys)
          .catch(() => {});
      }
    } catch (error) {
      console.error('[PostLoginService] Failed to load follow list:', error);
    }
  }

  /**
   * Apply the v1-only background-fetch gates to the CURRENT interface:
   * classic = article-notification polling + mention-profile preload run;
   * Focus UI = both off (objects fetch on open). Every step is idempotent
   * (ArticleNotificationService.isPollingStarted, MentionProfileCache
   * cachedSuggestions), so this is safe to call on every toggle AND at
   * login — one code path for both moments.
   */
  private syncBackgroundFetchGate(): void {
    if (isFocusUiEnabled()) {
      void import('./ArticleNotificationService').then(
        ({ ArticleNotificationService }) => {
          ArticleNotificationService.getInstance().stopPolling();
        }
      );
      // Focus UI (v2): silence the v1 list auto-sync (idempotent pause;
      // resume happens in the classic branch below).
      void import('./AutoSyncService').then(({ AutoSyncService }) => {
        AutoSyncService.getInstance().pauseForFocusUi();
      });
      return;
    }
    // Classic interface: re-arm the v1 list auto-sync (no-op when
    // already running)…
    void import('./AutoSyncService').then(({ AutoSyncService }) => {
      AutoSyncService.getInstance().resumeFromFocusUi();
    });
    // …start the article poller (no-op when already running)…
    void import('./ArticleNotificationService').then(
      ({ ArticleNotificationService }) => {
        ArticleNotificationService.getInstance().startPolling();
      }
    );
    // …and warm the mention-profile cache (no-op when already loaded).
    void import('./MentionProfileCache').then(({ MentionProfileCache }) => {
      const following = this.appState.getState('user').followingPubkeys;
      if (following.length > 0) {
        MentionProfileCache.getInstance()
          .preloadProfiles(following)
          .catch(() => {});
      }
    });
  }
}
