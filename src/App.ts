/**
 * Main Application Class
 * Coordinates all application modules and manages the application lifecycle.
 * GLUE ONLY -- no business logic. All logic lives in services.
 */

import { MainLayout } from './components/layout/MainLayout';
import { Router } from './services/Router';
import { NavigationDispatcher } from './services/NavigationDispatcher';
import { AppState } from './services/AppState';
import { AuthService } from './services/AuthService';
import { SystemLogger } from './services/SystemLogger';
import { TypedEventBus } from './core/TypedEventBus';
import { KeySignerClient } from './services/KeySignerClient';
import { ModalService } from './services/ModalService';
import { PlatformService } from './services/PlatformService';
import { ConnectivityService } from './services/ConnectivityService';
import { OfflineOverlay } from './components/system/OfflineOverlay';
import { CollapsibleManager } from './components/ui/note-features/CollapsibleManager';
import { TextSelectionToolbar } from './components/ui/TextSelectionToolbar';
import { FontSizeService } from './services/FontSizeService';
import { ThemeService } from './services/ThemeService';
import {
  initDiagnosticLogger,
  destroyDiagnosticLogger,
} from './services/DiagnosticLogger';
import { ViewMountingService } from './services/ViewMountingService';
import { PostLoginService } from './services/PostLoginService';
import { closeAllPerAccountDatabases } from './services/persistence/NoorDB';
import { AddonLoader } from './addons/AddonLoader';
import { registerCoreAddons } from './addons/registerAddons';
import { ensurePersistentStorage } from './helpers/ensurePersistentStorage';
import { ModuleLoader } from './core/ModuleLoader';
import { registerCoreModules } from './core/registerModules';
import { decodeNip19 } from './services/NostrToolsAdapter';
import { hexToNpub } from './helpers/nip19';

/** Maps viewName to the AppState key that stores the route parameter */
const VIEW_PARAM_STATE_KEY: Record<string, string> = {
  'single-note': 'currentNoteId',
  profile: 'currentProfileNpub',
  article: 'currentArticleNaddr',
  'relay-browser': 'currentRelayUrl',
  'epub-reader': 'currentReaderUrl',
};

export class App {
  private appElement: HTMLElement | null = null;

  private router: Router;
  private appState: AppState;
  private authService: AuthService;
  private eventBus: TypedEventBus;
  private systemLogger: SystemLogger;
  private viewMountingService: ViewMountingService;
  private postLoginService: PostLoginService;

  constructor() {
    this.appElement = document.getElementById('app');
    if (!this.appElement) {
      throw new Error('App element not found');
    }

    this.router = Router.getInstance();
    this.appState = AppState.getInstance();
    this.authService = AuthService.getInstance();
    this.eventBus = TypedEventBus.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.viewMountingService = ViewMountingService.getInstance();
    this.postLoginService = PostLoginService.getInstance();
  }

  async initialize(): Promise<void> {
    // Mark origin storage persistent so the WebView can't evict IndexedDB (NWC DB loss). Non-blocking.
    void ensurePersistentStorage();

    this.setupRoutes();

    this.setupUI();

    this.setupEventListeners();

    // Central back/forward routing for mouse thumb buttons + Android hardware back.
    NavigationDispatcher.init();

    // Bootstrap AddonLoader BEFORE any await, so its user:login listener
    // is registered before loadSession() (started in AuthService constructor)
    // can emit the event. Any await (e.g. checkConnectivity) yields to the
    // event loop, giving loadSession() a chance to finish first.
    registerCoreAddons();
    AddonLoader.getInstance().bootstrap();

    registerCoreModules();
    ModuleLoader.getInstance().bootstrap();

    OfflineOverlay.getInstance();
    CollapsibleManager.init();
    FontSizeService.getInstance();
    ThemeService.getInstance();

    // Offline publish queue (M6.1): must exist before any publish can fail —
    // listens for `publish:failed-all` and persists signed events for retry.
    import('./services/PublishQueueService')
      .then(m => m.PublishQueueService.getInstance())
      .catch(err => console.debug('[App] PublishQueue init failed:', err));

    // Inline BOLT11 invoice pay handler (event delegation)
    import('./services/Bolt11PayHandler')
      .then(m => m.initBolt11PayHandler())
      .catch(err => console.debug('[App] Bolt11PayHandler failed:', err));

    // Auto-seek video thumbnails + tap-to-load handler for Data Saver placeholders
    import('./helpers/renderMediaContent')
      .then(m => {
        m.startVideoThumbnailObserver();
        m.initMediaPlaceholderHandler();
        m.initImageTaglineTooltips();
        m.initEpubCardHandler();
      })
      .catch(err =>
        console.debug('[App] renderMediaContent init failed:', err)
      );

    // Global delegated click for .note-image--clickable (lightbox) +
    // global MutationObserver for video.note-video (download button + auto-pause).
    // Single source of truth — works for ANY render path / nesting depth.
    // See ImageClickHandler.ts / VideoPlayerService.ts headers + /build-validate guard.
    import('./components/ui/ImageClickHandler')
      .then(m => m.getImageClickHandler().init())
      .catch(err => console.debug('[App] ImageClickHandler init failed:', err));
    import('./services/VideoPlayerService')
      .then(m => m.getVideoPlayerService().init())
      .catch(err =>
        console.debug('[App] VideoPlayerService init failed:', err)
      );

    // Global avatar 404 fallback — any <img class="profile-pic"> whose URL fails
    // to load is swapped to its deterministic identicon. Pubkey comes from
    // data-pubkey on the img or its closest ancestor.
    import('./helpers/avatarFallback')
      .then(m => m.installImgErrorFallback())
      .catch(err => console.debug('[App] avatarFallback init failed:', err));

    // Global upload progress overlay — singleton, listens for media-upload:status
    // events from MediaUploadService. Renders compression + upload progress for
    // every video/audio upload regardless of which UI surface triggered it.
    import('./components/ui/UploadProgressOverlay')
      .then(m => m.UploadProgressOverlay.getInstance().mount())
      .catch(err =>
        console.debug('[App] UploadProgressOverlay init failed:', err)
      );

    // Resume any unfinished NIP-09 deletion broadcasts persisted from a previous
    // session (crash / app-quit / navigation mid-broadcast). Self-wires resume
    // triggers (app resume, visibility, connectivity) and drains in background.
    import('./services/BroadcastDeleteService')
      .then(m => m.BroadcastDeleteService.getInstance().resumePending())
      .catch(err =>
        console.debug('[App] BroadcastDeleteService resume failed:', err)
      );

    const isOnline =
      await ConnectivityService.getInstance().checkConnectivity();
    if (!isOnline) {
      OfflineOverlay.getInstance().show();
      return;
    }

    // Check for app updates (desktop only, non-blocking)
    const platform = PlatformService.getInstance();
    if (platform.isDesktop) {
      void this.checkForUpdates();
    }

    // Read ?r= relay browser parameter (captured early in main.ts before HMR can strip query params)
    const relayParam: string | null = window.__noornote_relay_param || null;
    if (relayParam) {
      delete window.__noornote_relay_param;
    }

    // Capture intended URL: ?r= override > explicit address-bar path (web) > sessionStorage (reload / Electron restore)
    const relayPath = relayParam
      ? `/relay/${encodeURIComponent(relayParam)}`
      : null;
    // sessionStorage survives an in-process reload; getPersistedURL is the mobile (Capacitor)
    // cold-start fallback (localStorage, recency-gated) for when Android killed the backgrounded process.
    const lastURL = this.router.getLastURL() ?? this.router.getPersistedURL();
    // In Electron prod, window.location.pathname is the on-disk file path of dist/index.html
    // (never matches an SPA route). Honor pathname only in true web builds; native deep links
    // arrive via electronAPI.onDeepLink / Capacitor app URL events.
    const browserPath = PlatformService.getInstance().isBrowser
      ? window.location.pathname
      : '/';
    // A specific address-bar path (web) is the user's explicit intent and must beat the stored
    // lastURL — otherwise pasting /note/X after landing on /login or /welcome keeps the stale
    // path and the user is stuck. lastURL stays the fallback for root '/' restore and Electron
    // (where browserPath is always '/').
    const intendedURL =
      relayPath || (browserPath !== '/' ? browserPath : null) || lastURL;

    // Wait for auth initialization with safety timeout
    let authTimedOut = false;
    await Promise.race([
      this.authService.waitForInitialization(),
      new Promise<void>(resolve =>
        setTimeout(() => {
          authTimedOut = true;
          resolve();
        }, 10000)
      ),
    ]);
    if (authTimedOut) {
      console.debug(
        '[App] Auth initialization timed out after 10s — continuing without session'
      );
    }

    // Initialize DiagnosticLogger early (Android: no npub needed, Desktop: after login)
    if (PlatformService.getInstance().isAndroid) {
      void initDiagnosticLogger();
    }

    const isLoggedIn = this.authService.hasValidSession();

    const targetPath = await this.resolveTargetPath(isLoggedIn, intendedURL);
    this.router.navigate(targetPath);

    // If user is already logged in from session restore, start services explicitly.
    // user:login may have been emitted before setupEventListeners() registered the handler.
    if (isLoggedIn) {
      const currentUser = this.authService.getCurrentUser();
      if (currentUser) {
        void initDiagnosticLogger(currentUser.npub);
        void this.postLoginService.handleLogin({
          npub: currentUser.npub,
          pubkey: currentUser.pubkey,
        });
        // Fallback: ensure addons load even if user:login was emitted before
        // AddonLoader subscribed. Already-loaded addons are skipped (idempotent).
        AddonLoader.getInstance().refresh(currentUser.pubkey, currentUser.npub);
        ModuleLoader.getInstance().refresh(
          currentUser.pubkey,
          currentUser.npub
        );
        await ModuleLoader.getInstance().awaitReady();

        // Restore the secondary pane (scc) from ?scc= now that the layout,
        // modules and session are ready (lists/views need a logged-in user).
        this.viewMountingService.getMainLayout()?.restoreSccFromUrl();
      }
    }

    this.setInitialFocus();
  }

  private async resolveTargetPath(
    isLoggedIn: boolean,
    intendedURL: string | null
  ): Promise<string> {
    if (!isLoggedIn) return intendedURL || '/';

    const { PerAccountLocalStorage, StorageKeys } = await import(
      './services/PerAccountLocalStorage'
    );
    const storage = PerAccountLocalStorage.getInstance();
    const currentUser = this.authService.getCurrentUser();
    const needsSetup = currentUser
      ? storage.getForPubkey<boolean>(
          StorageKeys.NEEDS_PROFILE_SETUP,
          currentUser.pubkey,
          false
        )
      : false;

    if (needsSetup) return '/setup';
    if (intendedURL && intendedURL !== '/login' && intendedURL !== '/welcome')
      return intendedURL;
    return '/';
  }

  private setInitialFocus(): void {
    const platform = PlatformService.getInstance();
    if (platform.isElectron) {
      // Electron: focus via DOM (window focus is handled by Electron shell)
      document.body.focus();
      return;
    }

    // Web/Capacitor: focus body element
    document.body.focus();
    document.body.tabIndex = -1;
  }

  private async checkForUpdates(): Promise<void> {
    try {
      const { UpdateCheckService } = await import(
        './services/UpdateCheckService'
      );
      const service = UpdateCheckService.getInstance();
      // App.ts is the glue layer: it owns the UI presentation so the
      // service stays free of component imports (no layer inversion).
      service.setUpdatePresenter(update => {
        void import('./components/modals/UpdateModal').then(
          ({ UpdateModal }) => {
            new UpdateModal().show(update);
          }
        );
      });
      await service.checkOnStartup();

      if (import.meta.env.DEV) {
        (window as unknown as Record<string, unknown>).__updateService =
          service;
      }
    } catch (error) {
      console.error('[App] Update check failed:', error);
    }
  }

  // ─── Route Registration ──────────────────────────────────────────────

  private registerMarketplaceRoutes(): void {
    this.registerRoute(
      '/marketplace',
      'marketplace',
      'marketplace',
      'npv',
      true
    );
    this.registerRoute(
      '/listing/:naddr',
      'listing',
      'listing',
      'lv',
      true,
      params => params.naddr
    );
    this.registerRoute(
      '/write-listing',
      'write-listing',
      'write-listing',
      'lev',
      true
    );
    this.registerRoute(
      '/write-listing/:naddr',
      'edit-listing',
      'edit-listing',
      'elv',
      true,
      params => params.naddr
    );
    this.registerRoute(
      '/my-listings',
      'my-listings',
      'my-listings',
      'mlv',
      true
    );
  }

  private registerRoute(
    path: string,
    viewName: string,
    viewType: string,
    shortcut: string,
    requiresAuth: boolean = false,
    paramHandler?: (
      params: Record<string, string | undefined>
    ) => string | undefined
  ): void {
    this.router.register(
      path,
      params => {
        const state: Record<string, unknown> = { currentView: viewName };

        let param: string | undefined;
        if (paramHandler) {
          param = paramHandler(params);

          const stateKey = VIEW_PARAM_STATE_KEY[viewName];
          if (stateKey) {
            state[stateKey] = param;
          } else if (viewName === 'conversation') {
            state.params = { pubkey: param };
          }
        }

        this.appState.setState('view', state);
        void this.viewMountingService.mountView(viewType, param);
      },
      shortcut,
      requiresAuth
    );
  }

  private setupRoutes(): void {
    // Public routes (Onboarding)
    this.registerRoute('/welcome', 'welcome', 'welcome', 'welcome-view');
    this.registerRoute(
      '/createnewaccount',
      'create-account',
      'create-account',
      'create-account-view'
    );
    this.registerRoute('/login', 'login', 'not-logged-in', 'login-view');
    this.registerRoute('/setup', 'setup', 'profile-setup', 'setup-view');
    this.registerRoute('/about', 'about', 'about', 'abv');
    this.registerRoute('/articles', 'articles', 'articles', 'atv');

    // Parameterized routes (public)
    this.registerRoute(
      '/note/:noteId',
      'single-note',
      'single-note',
      'snv',
      false,
      params => params.noteId ?? ''
    );
    this.registerRoute(
      '/profile/:npub',
      'profile',
      'profile',
      'pv',
      false,
      params => params.npub ?? ''
    );
    this.registerRoute(
      '/article/:naddr',
      'article',
      'article',
      'av',
      false,
      params => params.naddr
    );
    this.registerRoute(
      '/relay/:relayUrl',
      'relay-browser',
      'relay-browser',
      'rbv',
      false,
      params =>
        params.relayUrl ? decodeURIComponent(params.relayUrl) : undefined
    );
    this.registerRoute(
      '/reader/:encodedUrl',
      'epub-reader',
      'epub-reader',
      'erv',
      false,
      params =>
        params.encodedUrl ? decodeURIComponent(params.encodedUrl) : undefined
    );
    this.registerRoute(
      '/follow-pack/:naddr',
      'follow-pack',
      'follow-pack',
      'fpv',
      false,
      params => params.naddr
    );
    this.registerRoute(
      '/zapstore/:naddr',
      'zapstore',
      'zapstore',
      'zsv',
      false,
      params => params.naddr
    );

    // Authenticated routes
    this.registerRoute('/', 'timeline', 'timeline', 'tv', true);
    this.registerRoute(
      '/notifications',
      'notifications',
      'notifications',
      'nv',
      true
    );
    this.registerRoute('/settings', 'settings', 'settings', 'sv', true);
    this.registerRoute(
      '/settings/ui',
      'settings-ui',
      'settings-ui',
      'sv',
      true
    );
    this.registerRoute(
      '/settings/notification-priorities',
      'settings-notif',
      'settings-notif',
      'sv',
      true
    );
    this.registerRoute(
      '/settings/relays',
      'settings-relays',
      'settings-relays',
      'sv',
      true
    );
    this.registerRoute(
      '/settings/key-signer',
      'settings-key-signer',
      'settings-key-signer',
      'sv',
      true
    );
    this.registerRoute(
      '/settings/media',
      'settings-media',
      'settings-media',
      'sv',
      true
    );
    this.registerRoute(
      '/settings/zaps',
      'settings-zaps',
      'settings-zaps',
      'sv',
      true
    );
    this.registerRoute(
      '/settings/privacy',
      'settings-privacy',
      'settings-privacy',
      'sv',
      true
    );
    this.registerRoute(
      '/settings/cache',
      'settings-cache',
      'settings-cache',
      'sv',
      true
    );
    this.registerRoute('/messages', 'messages', 'messages', 'mv', true);
    this.registerRoute(
      '/write-article',
      'write-article',
      'write-article',
      'aev',
      true
    );
    this.registerRoute(
      '/edit-article/:naddr',
      'edit-article',
      'edit-article',
      'aev',
      true,
      params => params.naddr
    );
    this.registerRoute(
      '/write-video',
      'write-video',
      'write-video',
      'vev',
      true
    );
    this.registerRoute('/tribes', 'tribes', 'tribes', 'tribes-view', true);

    // Parameterized routes (authenticated)
    this.registerRoute(
      '/messages/:pubkey',
      'conversation',
      'conversation',
      'cv',
      true,
      params => params.pubkey
    );

    // Add-Ons routes — one dedicated view per addon
    this.registerRoute(
      '/addons/bookmarks',
      'addon-bookmarks',
      'addon-bookmarks',
      'adv',
      true
    );
    this.registerRoute(
      '/addons/tribes',
      'addon-tribes',
      'addon-tribes',
      'adv',
      true
    );
    this.registerRoute(
      '/addons/extended-follows',
      'addon-extended-follows',
      'addon-extended-follows',
      'adv',
      true
    );
    this.registerRoute(
      '/addons/wallet-balance',
      'addon-wallet-balance',
      'addon-wallet-balance',
      'adv',
      true
    );
    this.registerRoute(
      '/addons/profile-recognition',
      'addon-profile-recognition',
      'addon-profile-recognition',
      'adv',
      true
    );
    this.registerRoute(
      '/addons/marketplace',
      'addon-marketplace',
      'addon-marketplace',
      'adv',
      true
    );
    this.registerRoute(
      '/addons/follow-packs',
      'addon-follow-packs',
      'addon-follow-packs',
      'adv',
      true
    );
    this.registerRoute(
      '/addons/follower-notification',
      'addon-follower-notification',
      'addon-follower-notification',
      'adv',
      true
    );
    this.registerRoute(
      '/addons/hashtag-subscriptions',
      'addon-hashtag-subscriptions',
      'addon-hashtag-subscriptions',
      'adv',
      true
    );
    this.registerRoute(
      '/addons/list-settings',
      'addon-list-settings',
      'addon-list-settings',
      'adv',
      true
    );
    this.registerRoute(
      '/addons/custom-emojis',
      'addon-custom-emojis',
      'addon-custom-emojis',
      'adv',
      true
    );
    this.registerRoute(
      '/addons/wordfilter',
      'addon-wordfilter',
      'addon-wordfilter',
      'adv',
      true
    );
    this.registerRoute(
      '/addons/live-streams-player',
      'addon-live-streams-player',
      'addon-live-streams-player',
      'adv',
      true
    );
    this.registerRoute(
      '/addons/scheduled-posts',
      'addon-scheduled-posts',
      'addon-scheduled-posts',
      'adv',
      true
    );
    this.registerRoute(
      '/addons/badges',
      'addon-badges',
      'addon-badges',
      'adv',
      true
    );
    this.registerRoute(
      '/addons/note-taking',
      'addon-note-taking',
      'addon-note-taking',
      'adv',
      true
    );
    this.registerRoute(
      '/addons/bulk-delete',
      'addon-bulk-delete',
      'addon-bulk-delete',
      'adv',
      true
    );
    this.registerRoute(
      '/addons/nostr-majlis',
      'addon-nostr-majlis',
      'addon-nostr-majlis',
      'adv',
      true
    );
    // Tab-addressable variant so a dhikr notification can deep-link straight to the Community Dhikr tab.
    this.registerRoute(
      '/addons/nostr-majlis/:tab',
      'addon-nostr-majlis',
      'addon-nostr-majlis',
      'adv',
      true,
      params => params.tab
    );
    this.registerRoute(
      '/addons/group-chats',
      'addon-group-chats',
      'addon-group-chats',
      'adv',
      true
    );
    this.registerRoute(
      '/addons/analytics',
      'addon-analytics',
      'addon-analytics',
      'adv',
      true
    );
    // /addons (no slug) → redirect to first addon
    this.router.register('/addons', () =>
      this.router.navigate('/addons/bookmarks')
    );
    this.registerMarketplaceRoutes();

    // Catch-all: bare nip19 entities in URL path (njump.me links like noornote.app/nprofile1...)
    this.router.register(
      '/:entity',
      params => {
        const entity = params['entity'];
        if (!entity) return;

        if (!this.routeNip19Entity(entity)) {
          this.router.navigate('/');
        }
      },
      'nip19-entity'
    );
  }

  /**
   * Decode a nip19 entity and navigate to its view. Normalizes nprofile→npub
   * and nevent→note so URLs stay canonical. Returns false when the string is
   * not a routable nip19 entity — the caller decides error handling.
   */
  private routeNip19Entity(entity: string): boolean {
    try {
      const decoded = decodeNip19(entity);
      const type = decoded.type;

      if (type === 'npub' || type === 'nprofile') {
        const npub =
          type === 'npub'
            ? entity
            : hexToNpub((decoded.data as { pubkey: string }).pubkey);
        if (npub) {
          this.router.navigate(`/profile/${npub}`);
          return true;
        }
        return false;
      }

      if (type === 'note' || type === 'nevent') {
        const noteId =
          type === 'note'
            ? entity
            : `note1${(decoded.data as { id: string }).id}`;
        this.router.navigate(`/note/${noteId}`);
        return true;
      }

      if (type === 'naddr') {
        const addrData = decoded.data as { kind: number };
        this.router.navigate(
          App.getRouteForAddressableEvent(addrData.kind, entity)
        );
        return true;
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Route an addressable event (naddr) to the correct view based on kind
   */
  static getRouteForAddressableEvent(kind: number, naddr: string): string {
    switch (kind) {
      case 32267:
        return `/zapstore/${naddr}`;
      case 39089:
        return `/follow-pack/${naddr}`;
      case 30402:
        return `/listing/${naddr}`;
      case 30030:
        return `/note/${naddr}`;
      default:
        return `/article/${naddr}`;
    }
  }

  // ─── UI & Event Listeners ────────────────────────────────────────────

  private setupUI(): void {
    if (!this.appElement) return;

    const mainLayout = new MainLayout();
    this.appElement.appendChild(mainLayout.getElement());
    this.viewMountingService.setMainLayout(mainLayout);
  }

  private setupEventListeners(): void {
    document.addEventListener('visibilitychange', () => {
      void this.handleVisibilityChange();
    });
    this.setupExternalLinkHandler();
    this.setupHashtagClickHandler();
    void this.setupDeepLinkHandler();

    // Mouse-selection driven NIP-84 highlight trigger (desktop only).
    TextSelectionToolbar.getInstance().init();

    this.eventBus.on('user:login', (data: { npub: string; pubkey: string }) => {
      void initDiagnosticLogger(data.npub);
      void this.postLoginService.handleLogin(data);
    });

    this.eventBus.on('relays:updated', () => {
      this.viewMountingService.destroyTimelineCache();
      const viewState = this.appState.getState('view');
      if (viewState?.currentView === 'timeline') {
        void this.viewMountingService.mountView('timeline');
      }
    });

    this.eventBus.on('user:logout', () => {
      closeAllPerAccountDatabases();
      destroyDiagnosticLogger();
      this.postLoginService.resetLoginState();
      this.viewMountingService.destroyAllCaches();
      const primaryContent = document.querySelector('.primary-content');
      if (primaryContent) {
        primaryContent.innerHTML = '';
      }
      this.router.navigate('/login');
    });

    void this.setupDesktopCloseHandler();
  }

  // ─── Platform Handlers (thin glue) ───────────────────────────────────

  private async setupDeepLinkHandler(): Promise<void> {
    const platform = PlatformService.getInstance();
    if (!platform.isElectron) return;

    const handleDeepLink = (url: string) => {
      const nip19String = url.startsWith('nostr:') ? url.slice(6) : url;
      if (!this.routeNip19Entity(nip19String)) {
        this.systemLogger.warn(
          'Deep Link',
          `Failed to handle nostr: URL: ${url}`
        );
      }
    };

    try {
      window.electronAPI!.onDeepLink(url => handleDeepLink(url));
    } catch {
      // Deep link handler setup failed - expected in non-desktop environments
    }
  }

  private async setupDesktopCloseHandler(): Promise<void> {
    const platform = PlatformService.getInstance();
    if (!platform.isDesktop) return;

    const handleCloseRequest = async (closeFn: () => Promise<void>) => {
      const authMethod = this.authService.getAuthMethod();
      if (authMethod !== 'key-signer') return;

      const keySignerClient = KeySignerClient.getInstance();
      const isDaemonRunning = await keySignerClient.isRunning();

      if (!isDaemonRunning) {
        await closeFn();
        return;
      }

      const shouldStopDaemon = await ModalService.getInstance().confirm({
        title: 'Stop NoorSigner Daemon?',
        message:
          'The NoorSigner daemon is currently running. Do you want to stop it when closing the app?',
        confirmText: 'Stop Daemon',
        cancelText: 'Keep Running',
        confirmDestructive: false,
      });

      if (shouldStopDaemon) {
        try {
          await keySignerClient.stopDaemon();
        } catch {
          // Daemon stop failed - continue closing anyway
        }
      }

      await closeFn();
    };

    try {
      window.electronAPI!.onCloseRequested(() => {
        void handleCloseRequest(async () => {
          // Electron: closing proceeds after callback returns
        });
      });
    } catch {
      // Close handler setup failed - expected in non-desktop environments
    }
  }

  private async handleVisibilityChange(): Promise<void> {
    if (document.visibilityState !== 'visible') return;

    const ml = ModuleLoader.getInstance();
    const notificationsApi =
      ml.getApi<
        import('./modules/notifications/contracts').NotificationsModuleApi
      >('notifications');
    const dmsApi =
      ml.getApi<import('./modules/dms/contracts').DMsModuleApi>('dms');

    const [notifResult, dmResult] = await Promise.allSettled([
      notificationsApi?.refreshSubscriptions() ?? Promise.resolve(),
      dmsApi?.refreshSubscriptions() ?? Promise.resolve(),
    ]);

    if (notifResult.status === 'rejected') {
      this.systemLogger.error(
        'App',
        'Notification refresh failed on visibility change:',
        notifResult.reason
      );
    }
    if (dmResult.status === 'rejected') {
      this.systemLogger.error(
        'App',
        'DM refresh failed on visibility change:',
        dmResult.reason
      );
    }
  }

  private setupExternalLinkHandler(): void {
    document.addEventListener('click', event => {
      void this.handleExternalLinkClick(event);
    });
  }

  private async handleExternalLinkClick(event: MouseEvent): Promise<void> {
    const target = event.target as HTMLElement;
    const anchor = target.closest('a');
    if (!anchor) return;

    const href = anchor.getAttribute('href');
    if (
      !href ||
      (!href.startsWith('http://') &&
        !href.startsWith('https://') &&
        !href.startsWith('mailto:'))
    )
      return;

    event.preventDefault();

    try {
      const _platform = PlatformService.getInstance();
      if (_platform.isElectron) {
        await window.electronAPI!.openExternal(href);
      } else {
        window.open(href, '_blank', 'noopener,noreferrer');
      }
    } catch {
      // External link open failed
    }
  }

  private setupHashtagClickHandler(): void {
    document.addEventListener('click', event => {
      const target = event.target as HTMLElement;
      const hashtagEl = target.closest('.hashtag');
      if (!hashtagEl) return;

      event.preventDefault();
      const tag = (hashtagEl as HTMLElement).dataset.tag;
      if (tag) {
        this.eventBus.emit('hashtagSearch:start', { hashtag: tag });
      }
    });
  }
}
