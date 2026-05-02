/**
 * Main Application Class
 * Coordinates all application modules and manages the application lifecycle.
 * GLUE ONLY -- no business logic. All logic lives in services.
 */

import { MainLayout } from './components/layout/MainLayout';
import { Router } from './services/Router';
import { AppState } from './services/AppState';
import { AuthService } from './services/AuthService';
import { SystemLogger } from './components/system/SystemLogger';
import { EventBus } from './services/EventBus';
import { KeySignerClient } from './services/KeySignerClient';
import { ModalService } from './services/ModalService';
import { PlatformService } from './services/PlatformService';
import { ConnectivityService } from './services/ConnectivityService';
import { OfflineOverlay } from './components/system/OfflineOverlay';
import { CollapsibleManager } from './components/ui/note-features/CollapsibleManager';
import { FontSizeService } from './services/FontSizeService';
import { ThemeService } from './services/ThemeService';
import { initDiagnosticLogger, destroyDiagnosticLogger } from './services/DiagnosticLogger';
import { ViewMountingService } from './services/ViewMountingService';
import { PostLoginService } from './services/PostLoginService';
import { AddonLoader } from './addons/AddonLoader';
import { registerCoreAddons } from './addons/registerAddons';
import { decodeNip19 } from './services/NostrToolsAdapter';
import { PublicPageBootstrap } from './addons/nospress/PublicPageBootstrap';
import { hexToNpub } from './helpers/nip19';

/** Maps viewName to the AppState key that stores the route parameter */
const VIEW_PARAM_STATE_KEY: Record<string, string> = {
  'single-note': 'currentNoteId',
  'profile': 'currentProfileNpub',
  'article': 'currentArticleNaddr',
  'relay-browser': 'currentRelayUrl',
};

export class App {
  private appElement: HTMLElement | null = null;

  private router: Router;
  private appState: AppState;
  private authService: AuthService;
  private eventBus: EventBus;
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
    this.eventBus = EventBus.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.viewMountingService = ViewMountingService.getInstance();
    this.postLoginService = PostLoginService.getInstance();
  }

  async initialize(): Promise<void> {
    this.setupRoutes();

    // Public-page boot path: when the URL is a top-level npub or nip05, we
    // skip MainLayout entirely. The actual decision (logged-in redirect vs.
    // public-view mount) finalizes after auth-init below.
    const publicMatch = PublicPageBootstrap.detect();
    if (!publicMatch) this.setupUI();

    this.setupEventListeners();

    // Bootstrap AddonLoader BEFORE any await, so its user:login listener
    // is registered before loadSession() (started in AuthService constructor)
    // can emit the event. Any await (e.g. checkConnectivity) yields to the
    // event loop, giving loadSession() a chance to finish first.
    registerCoreAddons();
    AddonLoader.getInstance().bootstrap();

    OfflineOverlay.getInstance();
    CollapsibleManager.init();
    FontSizeService.getInstance();
    ThemeService.getInstance();

    // Inline BOLT11 invoice pay handler (event delegation)
    import('./services/Bolt11PayHandler').then(m => m.initBolt11PayHandler());

    // Auto-seek video thumbnails + tap-to-load handler for Data Saver placeholders
    import('./helpers/renderMediaContent').then(m => {
      m.startVideoThumbnailObserver();
      m.initMediaPlaceholderHandler();
    });

    // Global delegated click for .note-image--clickable (lightbox) +
    // global MutationObserver for video.note-video (download button + auto-pause).
    // Single source of truth — works for ANY render path / nesting depth.
    // See ImageClickHandler.ts / VideoPlayerService.ts headers + /build-validate guard.
    import('./services/ImageClickHandler').then(m => m.getImageClickHandler().init());
    import('./services/VideoPlayerService').then(m => m.getVideoPlayerService().init());

    const isOnline = await ConnectivityService.getInstance().checkConnectivity();
    if (!isOnline) {
      OfflineOverlay.getInstance().show();
      return;
    }

    // Check for app updates (desktop only, non-blocking)
    const platform = PlatformService.getInstance();
    if (platform.isDesktop) {
      this.checkForUpdates();
    }

    // Read ?r= relay browser parameter (captured early in main.ts before HMR can strip query params)
    const relayParam: string | null = (window as any).__noornote_relay_param || null;
    if (relayParam) {
      delete (window as any).__noornote_relay_param;
    }

    // Capture intended URL: ?r= override > sessionStorage (reload) > browser path (external link)
    const relayPath = relayParam ? `/relay/${encodeURIComponent(relayParam)}` : null;
    const lastURL = this.router.getLastURL();
    // In Electron prod, window.location.pathname is the on-disk file path of dist/index.html
    // (never matches an SPA route). Honor pathname only in true web builds; native deep links
    // arrive via electronAPI.onDeepLink / Capacitor app URL events.
    const browserPath = PlatformService.getInstance().isBrowser ? window.location.pathname : '/';
    const intendedURL = relayPath || lastURL || (browserPath !== '/' ? browserPath : null);

    // Wait for auth initialization with safety timeout
    let authTimedOut = false;
    await Promise.race([
      this.authService.waitForInitialization(),
      new Promise<void>(resolve => setTimeout(() => {
        authTimedOut = true;
        resolve();
      }, 10000)),
    ]);
    if (authTimedOut) {
      console.warn('[App] Auth initialization timed out after 10s — continuing without session');
    }

    // Initialize DiagnosticLogger early (Android: no npub needed, Desktop: after login)
    if (PlatformService.getInstance().isAndroid) {
      initDiagnosticLogger();
    }

    const isLoggedIn = this.authService.hasValidSession();

    // Public-page boot branch: a public NosPress URL renders the clean
    // single-column page regardless of auth state. Logged-in NoorNote users
    // additionally get a sticky admin-style top-bar with quick-nav back into
    // the app — owners of the page see an extra "Edit" button.
    if (publicMatch && this.appElement) {
      await PublicPageBootstrap.mountPublicView(publicMatch, this.appElement);
      return;
    }

    const targetPath = await this.resolveTargetPath(isLoggedIn, intendedURL);
    this.router.navigate(targetPath);

    // If user is already logged in from session restore, start services explicitly.
    // user:login may have been emitted before setupEventListeners() registered the handler.
    if (isLoggedIn) {
      const currentUser = this.authService.getCurrentUser();
      if (currentUser) {
        initDiagnosticLogger(currentUser.npub);
        this.postLoginService.handleLogin({ npub: currentUser.npub, pubkey: currentUser.pubkey });
        // Fallback: ensure addons load even if user:login was emitted before
        // AddonLoader subscribed. Already-loaded addons are skipped (idempotent).
        AddonLoader.getInstance().refresh(currentUser.pubkey, currentUser.npub);
      }
    }

    this.setInitialFocus();
  }

  private async resolveTargetPath(isLoggedIn: boolean, intendedURL: string | null): Promise<string> {
    if (!isLoggedIn) return intendedURL || '/';

    const { PerAccountLocalStorage, StorageKeys } = await import('./services/PerAccountLocalStorage');
    const storage = PerAccountLocalStorage.getInstance();
    const currentUser = this.authService.getCurrentUser();
    const needsSetup = currentUser
      ? storage.getForPubkey<boolean>(StorageKeys.NEEDS_PROFILE_SETUP, currentUser.pubkey, false)
      : false;

    if (needsSetup) return '/setup';
    if (intendedURL && intendedURL !== '/login' && intendedURL !== '/welcome') return intendedURL;
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
      const { UpdateCheckService } = await import('./services/UpdateCheckService');
      const service = UpdateCheckService.getInstance();
      await service.checkOnStartup();

      if (import.meta.env.DEV) {
        (window as any).__updateService = service;
      }
    } catch (error) {
      console.error('[App] Update check failed:', error);
    }
  }

  // ─── Route Registration ──────────────────────────────────────────────

  private registerMarketplaceRoutes(): void {
    this.registerRoute('/marketplace', 'marketplace', 'marketplace', 'npv', true);
    this.registerRoute('/listing/:naddr', 'listing', 'listing', 'lv', true,
      (params) => params.naddr);
    this.registerRoute('/write-listing', 'write-listing', 'write-listing', 'lev', true);
    this.registerRoute('/write-listing/:naddr', 'edit-listing', 'edit-listing', 'elv', true,
      (params) => params.naddr);
    this.registerRoute('/my-listings', 'my-listings', 'my-listings', 'mlv', true);
  }

  private registerRoute(
    path: string,
    viewName: string,
    viewType: string,
    shortcut: string,
    requiresAuth: boolean = false,
    paramHandler?: (params: Record<string, string | undefined>) => string | undefined
  ): void {
    this.router.register(
      path,
      (params) => {
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
        this.viewMountingService.mountView(viewType, param);
      },
      shortcut,
      requiresAuth
    );
  }

  private setupRoutes(): void {
    // Public routes (Onboarding)
    this.registerRoute('/welcome', 'welcome', 'welcome', 'welcome-view');
    this.registerRoute('/createnewaccount', 'create-account', 'create-account', 'create-account-view');
    this.registerRoute('/login', 'login', 'not-logged-in', 'login-view');
    this.registerRoute('/setup', 'setup', 'profile-setup', 'setup-view');
    this.registerRoute('/about', 'about', 'about', 'abv');
    this.registerRoute('/articles', 'articles', 'articles', 'atv');

    // Parameterized routes (public)
    this.registerRoute('/note/:noteId', 'single-note', 'single-note', 'snv', false,
      (params) => params.noteId ?? '');
    this.registerRoute('/profile/:npub/nospress/edit/fullscreen', 'nospress-fullscreen', 'nospress-fullscreen', 'npev', true,
      (params) => params.npub ?? '');
    this.registerRoute('/profile/:npub/nospress/edit', 'nospress-edit', 'nospress-edit', 'npev', true,
      (params) => params.npub ?? '');
    this.registerRoute('/profile/:npub/nospress', 'nospress', 'nospress', 'npv', false,
      (params) => params.npub ?? '');
    this.registerRoute('/profile/:npub', 'profile', 'profile', 'pv', false,
      (params) => params.npub ?? '');
    this.registerRoute('/article/:naddr', 'article', 'article', 'av', false,
      (params) => params.naddr);
    this.registerRoute('/relay/:relayUrl', 'relay-browser', 'relay-browser', 'rbv', false,
      (params) => params.relayUrl ? decodeURIComponent(params.relayUrl) : undefined);
    this.registerRoute('/follow-pack/:naddr', 'follow-pack', 'follow-pack', 'fpv', false,
      (params) => params.naddr);
    this.registerRoute('/zapstore/:naddr', 'zapstore', 'zapstore', 'zsv', false,
      (params) => params.naddr);

    // Authenticated routes
    this.registerRoute('/', 'timeline', 'timeline', 'tv', true);
    this.registerRoute('/notifications', 'notifications', 'notifications', 'nv', true);
    this.registerRoute('/settings', 'settings', 'settings', 'sv', true);
    this.registerRoute('/settings/ui', 'settings-ui', 'settings-ui', 'sv', true);
    this.registerRoute('/settings/notification-priorities', 'settings-notif', 'settings-notif', 'sv', true);
    this.registerRoute('/settings/relays', 'settings-relays', 'settings-relays', 'sv', true);
    this.registerRoute('/settings/key-signer', 'settings-key-signer', 'settings-key-signer', 'sv', true);
    this.registerRoute('/settings/media', 'settings-media', 'settings-media', 'sv', true);
    this.registerRoute('/settings/zaps', 'settings-zaps', 'settings-zaps', 'sv', true);
    this.registerRoute('/settings/privacy', 'settings-privacy', 'settings-privacy', 'sv', true);
    this.registerRoute('/settings/cache', 'settings-cache', 'settings-cache', 'sv', true);
    this.registerRoute('/messages', 'messages', 'messages', 'mv', true);
    this.registerRoute('/write-article', 'write-article', 'write-article', 'aev', true);
    this.registerRoute('/edit-article/:naddr', 'edit-article', 'edit-article', 'aev', true,
      (params) => params.naddr);
    this.registerRoute('/write-video', 'write-video', 'write-video', 'vev', true);
    this.registerRoute('/tribes', 'tribes', 'tribes', 'tribes-view', true);

    // Parameterized routes (authenticated)
    this.registerRoute('/messages/:pubkey', 'conversation', 'conversation', 'cv', true,
      (params) => params.pubkey);

    // Add-Ons routes — one dedicated view per addon
    this.registerRoute('/addons/bookmarks',             'addon-bookmarks',             'addon-bookmarks',             'adv', true);
    this.registerRoute('/addons/tribes',                'addon-tribes',                'addon-tribes',                'adv', true);
    this.registerRoute('/addons/extended-follows',      'addon-extended-follows',      'addon-extended-follows',      'adv', true);
    this.registerRoute('/addons/wallet-balance',        'addon-wallet-balance',        'addon-wallet-balance',        'adv', true);
    this.registerRoute('/addons/profile-recognition',   'addon-profile-recognition',   'addon-profile-recognition',   'adv', true);
    this.registerRoute('/addons/marketplace',           'addon-marketplace',           'addon-marketplace',           'adv', true);
    this.registerRoute('/addons/follow-packs',          'addon-follow-packs',          'addon-follow-packs',          'adv', true);
    this.registerRoute('/addons/nospress',                'addon-nospress',                'addon-nospress',                'adv', true);
    this.registerRoute('/addons/hashtag-subscriptions', 'addon-hashtag-subscriptions', 'addon-hashtag-subscriptions', 'adv', true);
    this.registerRoute('/addons/list-settings',         'addon-list-settings',         'addon-list-settings',         'adv', true);
    this.registerRoute('/addons/custom-emojis',         'addon-custom-emojis',         'addon-custom-emojis',         'adv', true);
    this.registerRoute('/addons/wordfilter',            'addon-wordfilter',            'addon-wordfilter',            'adv', true);
    this.registerRoute('/addons/live-streams-player',   'addon-live-streams-player',   'addon-live-streams-player',   'adv', true);
    this.registerRoute('/addons/scheduled-posts',       'addon-scheduled-posts',       'addon-scheduled-posts',       'adv', true);
    // /addons (no slug) → redirect to first addon
    this.router.register('/addons', () => this.router.navigate('/addons/bookmarks'));
    this.registerMarketplaceRoutes();

    // Catch-all: bare nip19 entities in URL path (njump.me links like noornote.app/nprofile1...)
    this.router.register(
      '/:entity',
      (params) => {
        const entity = params['entity'];
        if (!entity) return;

        try {
          const decoded = decodeNip19(entity);
          if (decoded.type === 'npub' || decoded.type === 'nprofile') {
            this.router.navigate(`/profile/${entity}`);
          } else if (decoded.type === 'note' || decoded.type === 'nevent') {
            this.router.navigate(`/note/${entity}`);
          } else if (decoded.type === 'naddr') {
            const addrData = decoded.data as { kind: number };
            this.router.navigate(App.getRouteForAddressableEvent(addrData.kind, entity));
          }
        } catch {
          this.router.navigate('/');
        }
      },
      'nip19-entity'
    );
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
    document.addEventListener('visibilitychange', this.handleVisibilityChange.bind(this));
    this.setupExternalLinkHandler();
    this.setupHashtagClickHandler();
    this.setupDeepLinkHandler();

    this.eventBus.on('user:login', (data: { npub: string; pubkey: string }) => {
      initDiagnosticLogger(data.npub);
      this.postLoginService.handleLogin(data);
    });

    this.eventBus.on('relays:updated', () => {
      this.viewMountingService.destroyTimelineCache();
      const viewState = this.appState.getState('view');
      if (viewState?.currentView === 'timeline') {
        this.viewMountingService.mountView('timeline');
      }
    });

    this.eventBus.on('user:logout', () => {
      destroyDiagnosticLogger();
      this.viewMountingService.destroyAllCaches();
      const primaryContent = document.querySelector('.primary-content');
      if (primaryContent) {
        primaryContent.innerHTML = '';
      }
      this.router.navigate('/login');
    });

    this.setupDesktopCloseHandler();
  }

  // ─── Platform Handlers (thin glue) ───────────────────────────────────

  private async setupDeepLinkHandler(): Promise<void> {
    const platform = PlatformService.getInstance();
    if (!platform.isElectron) return;

    const handleDeepLink = (url: string) => {
      try {
        const nip19String = url.startsWith('nostr:') ? url.slice(6) : url;
        const decoded = decodeNip19(nip19String);
        const type = decoded.type;

        if (type === 'npub' || type === 'nprofile') {
          const npub = type === 'npub'
            ? nip19String
            : hexToNpub((decoded.data as { pubkey: string }).pubkey);
          if (npub) {
            this.router.navigate(`/profile/${npub}`);
          }
          return;
        }

        if (type === 'note' || type === 'nevent') {
          const noteId = type === 'note'
            ? nip19String
            : `note1${(decoded.data as { id: string }).id}`;
          this.router.navigate(`/note/${noteId}`);
          return;
        }

        if (type === 'naddr') {
          const addrData = decoded.data as { kind: number };
          this.router.navigate(App.getRouteForAddressableEvent(addrData.kind, nip19String));
        }
      } catch {
        this.systemLogger.warn('Deep Link', `Failed to handle nostr: URL: ${url}`);
      }
    };

    try {
      window.electronAPI!.onDeepLink((url) => handleDeepLink(url));
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
        message: 'The NoorSigner daemon is currently running. Do you want to stop it when closing the app?',
        confirmText: 'Stop Daemon',
        cancelText: 'Keep Running',
        confirmDestructive: false
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
      window.electronAPI!.onCloseRequested(async () => {
        await handleCloseRequest(async () => {
          // Electron: closing proceeds after callback returns
        });
      });
    } catch {
      // Close handler setup failed - expected in non-desktop environments
    }
  }

  private async handleVisibilityChange(): Promise<void> {
    if (document.visibilityState !== 'visible') return;

    const [notifResult, dmResult] = await Promise.allSettled([
      import('./services/orchestration/NotificationsOrchestrator')
        .then(({ NotificationsOrchestrator }) => NotificationsOrchestrator.getInstance().refreshSubscriptions()),
      import('./services/dm/DMService')
        .then(({ DMService }) => DMService.getInstance().refreshSubscriptions())
    ]);

    if (notifResult.status === 'rejected') {
      this.systemLogger.error('App', 'Notification refresh failed on visibility change:', notifResult.reason);
    }
    if (dmResult.status === 'rejected') {
      this.systemLogger.error('App', 'DM refresh failed on visibility change:', dmResult.reason);
    }
  }

  private setupExternalLinkHandler(): void {
    document.addEventListener('click', async (event) => {
      const target = event.target as HTMLElement;
      const anchor = target.closest('a');
      if (!anchor) return;

      const href = anchor.getAttribute('href');
      if (!href || (!href.startsWith('http://') && !href.startsWith('https://') && !href.startsWith('mailto:'))) return;

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
    });
  }

  private setupHashtagClickHandler(): void {
    document.addEventListener('click', (event) => {
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

// Global type declarations for Vite environment variables
declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;
