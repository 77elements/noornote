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

  private constructor() {}

  public static getInstance(): PostLoginService {
    if (!PostLoginService.instance) {
      PostLoginService.instance = new PostLoginService();
    }
    return PostLoginService.instance;
  }

  public async handleLogin(data: { npub: string; pubkey: string }): Promise<void> {
    // Apply per-account UI prefs that need to be on <html> before any rendering
    const { PerAccountLocalStorage: PALS, StorageKeys: SK } = await import('./PerAccountLocalStorage');
    const cvEnabled = PALS.getInstance().getForPubkey<boolean>(SK.CONTENT_VISIBILITY_AUTO, data.pubkey, false);
    document.documentElement.classList.toggle('content-visibility-auto', cvEnabled);

    // Public-page CTA stash: when the user came in through a "logged out"
    // modal on a public page (NosPress) and just authenticated, jump to the
    // action-specific destination (DM thread, etc.) via a full reload so
    // App.ts's boot path sees the fresh logged-in state.
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
      const { PerAccountLocalStorage, StorageKeys } = await import('./PerAccountLocalStorage');
      const storage = PerAccountLocalStorage.getInstance();
      const needsSetup = storage.getForPubkey<boolean>(StorageKeys.NEEDS_PROFILE_SETUP, data.pubkey, false);

      this.router.navigate(needsSetup ? '/setup' : '/');
    }

    // Detect account switch and clear stale caches
    const lastLoggedInPubkey = localStorage.getItem('noornote_last_logged_in_pubkey');
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
      this.startService('notifications', async () => {
        const { NotificationsOrchestrator } = await import('./orchestration/NotificationsOrchestrator');
        await NotificationsOrchestrator.getInstance().start();
        const { ArticleNotificationService } = await import('./ArticleNotificationService');
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
      PetnameService.getInstance().syncFromRelays().catch(() => {});
    });
  }

  /**
   * Wraps a service startup function with error handling.
   * Prevents individual service failures from blocking other startups.
   */
  private async startService(name: string, fn: () => Promise<void>): Promise<void> {
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

      const followingPubkeys = await UserService.getInstance().getUserFollowing(pubkey);
      this.appState.setState('user', { followingPubkeys });

      MentionProfileCache.getInstance().preloadProfiles(followingPubkeys).catch(() => {});
    } catch (error) {
      console.error('[PostLoginService] Failed to load follow list:', error);
    }
  }
}
