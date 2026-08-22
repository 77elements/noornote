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
import { ViewMountingService } from './ViewMountingService';

export class PostLoginService {
  private static instance: PostLoginService;

  private router = Router.getInstance();
  private appState = AppState.getInstance();
  private viewMountingService = ViewMountingService.getInstance();

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
      // Apply per-account UI prefs that need to be on <html> before any rendering
      const { PerAccountLocalStorage: PALS, StorageKeys: SK } = await import(
        './PerAccountLocalStorage'
      );
      const cvEnabled = PALS.getInstance().getForPubkey<boolean>(
        SK.CONTENT_VISIBILITY_AUTO,
        data.pubkey,
        false
      );
      document.documentElement.classList.toggle(
        'content-visibility-auto',
        cvEnabled
      );

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
        const { CacheManager } = await import('./CacheManager');
        CacheManager.getInstance().clearUserSpecificCaches();

        this.viewMountingService.destroyTimelineCache();
        if (currentPath === '/' || currentPath === '/timeline') {
          this.viewMountingService.mountView('timeline');
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
          const { ArticleNotificationService } = await import(
            './ArticleNotificationService'
          );
          ArticleNotificationService.getInstance().startPolling();
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
      AutoSyncService.getInstance();

      // Sync petnames from relays (NIP-78 encrypted, non-blocking)
      import('./PetnameService').then(({ PetnameService }) => {
        PetnameService.getInstance()
          .syncFromRelays()
          .catch(() => {});
      });

      // Sync soft-mutes from relays (NIP-78 encrypted, non-blocking).
      // Notification-only suppression — consumed by NotificationsOrchestrator.
      import('./SoftMuteService').then(({ SoftMuteService }) => {
        SoftMuteService.getInstance()
          .syncFromRelays()
          .catch(() => {});
      });
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

      MentionProfileCache.getInstance()
        .preloadProfiles(followingPubkeys)
        .catch(() => {});
    } catch (error) {
      console.error('[PostLoginService] Failed to load follow list:', error);
    }
  }
}
