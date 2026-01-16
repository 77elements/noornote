/**
 * Main Application Class
 * Coordinates all application modules and manages the application lifecycle
 */

import { MainLayout } from './components/layout/MainLayout';
import { Router } from './services/Router';
import { AppState } from './services/AppState';
import { SingleNoteView } from './components/views/SingleNoteView';
import { ProfileView } from './components/views/ProfileView';
import { ArticleView } from './components/views/ArticleView';
import { SettingsView } from './components/views/SettingsView';
import { AboutView } from './components/views/AboutView';
import type { TimelineView } from './components/views/TimelineView';
import { AuthService } from './services/AuthService';
import { SystemLogger } from './components/system/SystemLogger';
import { EventBus } from './services/EventBus';
import { ViewLifecycleManager } from './services/ViewLifecycleManager';
import { KeySignerClient } from './services/KeySignerClient';
import { ModalService } from './services/ModalService';
import { PlatformService } from './services/PlatformService';
import { ConnectivityService } from './services/ConnectivityService';
import { OfflineOverlay } from './components/system/OfflineOverlay';
import { AutoSyncService } from './services/sync/AutoSyncService';
import { CollapsibleManager } from './components/ui/note-features/CollapsibleManager';
import { decodeNip19 } from './services/NostrToolsAdapter';
import { hexToNpub } from './helpers/nip19';

export class App {
  private appElement: HTMLElement | null = null;

  // Layout Component
  private mainLayout: MainLayout | null = null;

  // Core Services
  private router: Router;
  private appState: AppState;
  private authService: AuthService;
  private eventBus: EventBus;
  private systemLogger: SystemLogger;
  private viewLifecycleManager: ViewLifecycleManager;

  // View Components (reused instances)
  private timelineUI: TimelineView | null = null;
  private profileView: ProfileView | null = null;

  constructor() {
    this.appElement = document.getElementById('app');
    if (!this.appElement) {
      throw new Error('App element not found');
    }

    // Initialize Core Services (Singletons)
    this.router = Router.getInstance();
    this.appState = AppState.getInstance();
    this.authService = AuthService.getInstance();
    this.eventBus = EventBus.getInstance();
    this.systemLogger = SystemLogger.getInstance();
    this.viewLifecycleManager = ViewLifecycleManager.getInstance();
  }

  async initialize(): Promise<void> {
    this.setupRoutes();
    this.setupUI();
    this.setupEventListeners();

    // Initialize OfflineOverlay early so it can listen for runtime offline events
    OfflineOverlay.getInstance();

    // Initialize AutoSyncService to listen for list update events
    AutoSyncService.getInstance();

    // Initialize CollapsibleManager to listen for post truncation setting changes
    CollapsibleManager.init();

    // Check internet connectivity before proceeding
    const connectivityService = ConnectivityService.getInstance();
    const isOnline = await connectivityService.checkConnectivity();

    if (!isOnline) {
      OfflineOverlay.getInstance().show();
      return;
    }

    // Capture last URL BEFORE auth (to preserve it before auto-login overwrites it)
    const lastURL = this.router.getLastURL();

    // Wait for auth initialization before navigating to preserve current route on reload
    await this.waitForAuthReady();

    const isLoggedIn = this.authService.hasValidSession();

    // Determine target path: prioritize lastURL (reload case), fallback to login or timeline
    let targetPath: string;
    if (!isLoggedIn) {
      targetPath = '/login';
    } else if (lastURL && lastURL !== '/login') {
      targetPath = lastURL;
    } else {
      targetPath = '/';
    }

    this.router.navigate(targetPath);

    // Set focus to enable keyboard shortcuts immediately after app load
    this.setInitialFocus();
  }

  private async setInitialFocus(): Promise<void> {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const window = getCurrentWindow();
      await window.setFocus();
    } catch {
      setTimeout(() => {
        document.body.focus();
        document.body.tabIndex = -1;
      }, 100);
    }
  }

  private waitForAuthReady(): Promise<void> {
    return new Promise((resolve) => {
      if (this.authService.hasValidSession()) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        this.eventBus.off(subscriptionId);
        resolve();
      }, 1000);

      const subscriptionId = this.eventBus.on('user:login', () => {
        clearTimeout(timeout);
        this.eventBus.off(subscriptionId);
        resolve();
      });
    });
  }

  /**
   * Helper to register a route with consistent state/mount pattern
   */
  private registerRoute(
    path: string,
    viewName: string,
    viewType: string,
    shortcut: string,
    requiresAuth: boolean = false,
    stateExtras?: Record<string, unknown>,
    paramHandler?: (params: Record<string, string | undefined>) => string | undefined
  ): void {
    this.router.register(
      path,
      (params) => {
        const state: Record<string, unknown> = { currentView: viewName, ...stateExtras };

        // Handle parameterized routes
        let param: string | undefined;
        if (paramHandler) {
          param = paramHandler(params);
          if (viewName === 'single-note') state.currentNoteId = param;
          else if (viewName === 'profile') state.currentProfileNpub = param;
          else if (viewName === 'article') state.currentArticleNaddr = param;
          else if (viewName === 'conversation') state.params = { pubkey: param };
        }

        this.appState.setState('view', state);
        this.mountPrimaryContent(viewType, param);
      },
      shortcut,
      requiresAuth
    );
  }

  private setupRoutes(): void {
    // Public routes
    this.registerRoute('/login', 'login', 'not-logged-in', 'login-view');
    this.registerRoute('/about', 'about', 'about', 'abv');
    this.registerRoute('/articles', 'articles', 'articles', 'atv');

    // Parameterized routes (public)
    this.registerRoute('/note/:noteId', 'single-note', 'single-note', 'snv', false, {},
      (params) => params.noteId ?? '');
    this.registerRoute('/profile/:npub', 'profile', 'profile', 'pv', false, {},
      (params) => params.npub ?? '');
    this.registerRoute('/article/:naddr', 'article', 'article', 'av', false, {},
      (params) => params.naddr);

    // Authenticated routes
    this.registerRoute('/', 'timeline', 'timeline', 'tv', true);
    this.registerRoute('/notifications', 'notifications', 'notifications', 'nv', true);
    this.registerRoute('/settings', 'settings', 'settings', 'sv', true);
    this.registerRoute('/messages', 'messages', 'messages', 'mv', true);
    this.registerRoute('/write-article', 'write-article', 'write-article', 'aev', true);
    this.registerRoute('/tribes', 'tribes', 'tribes', 'tribes-view', true);

    // Parameterized routes (authenticated)
    this.registerRoute('/messages/:pubkey', 'conversation', 'conversation', 'cv', true, {},
      (params) => params.pubkey);
  }

  private async mountPrimaryContent(viewType: string, param?: string): Promise<void> {
    const primaryContent = document.querySelector('.primary-content');
    if (!primaryContent) return;

    // Unmount existing views via ViewLifecycleManager
    if (this.timelineUI && this.viewLifecycleManager.isViewMounted(this.timelineUI, primaryContent)) {
      this.viewLifecycleManager.onViewUnmount(this.timelineUI);
    }

    if (this.profileView && this.viewLifecycleManager.isViewMounted(this.profileView, primaryContent)) {
      this.viewLifecycleManager.onViewUnmount(this.profileView);
    }

    const systemLogger = SystemLogger.getInstance();
    systemLogger.clearPageLogs();

    primaryContent.innerHTML = '';

    switch (viewType) {
      case 'not-logged-in':
        if (this.mainLayout) {
          this.mainLayout.showLoginScreen();
        }
        break;

      case 'timeline': {
        if (!this.timelineUI) {
          const { TimelineView } = await import('./components/views/TimelineView');
          this.timelineUI = new TimelineView();
        }
        primaryContent.appendChild(this.timelineUI.getElement());
        this.viewLifecycleManager.onViewMount(this.timelineUI);
        break;
      }

      case 'single-note':
        if (param) {
          const snv = new SingleNoteView(param);
          primaryContent.appendChild(snv.getElement());
        }
        break;

      case 'profile':
        if (param) {
          if (!this.profileView || this.profileView.getNpub() !== param) {
            this.profileView = new ProfileView(param);
          }
          primaryContent.appendChild(this.profileView.getElement());
          this.viewLifecycleManager.onViewMount(this.profileView);
        }
        break;

      case 'article':
        if (param) {
          const articleView = new ArticleView(param);
          primaryContent.appendChild(articleView.getElement());
        }
        break;

      case 'notifications': {
        const { NotificationsView } = await import('./components/views/NotificationsView');
        const notificationsView = new NotificationsView();
        primaryContent.appendChild(notificationsView.getElement());
        break;
      }

      case 'settings': {
        const settingsView = new SettingsView();
        primaryContent.appendChild(settingsView.getElement());
        break;
      }

      case 'about': {
        const aboutView = new AboutView();
        primaryContent.appendChild(aboutView.getElement());
        break;
      }

      case 'write-article': {
        const { ArticleEditorView } = await import('./components/views/ArticleEditorView');
        const articleEditor = new ArticleEditorView();
        primaryContent.appendChild(articleEditor.getElement());
        break;
      }

      case 'articles': {
        const { ArticleTimelineView } = await import('./components/views/ArticleTimelineView');
        const articleTimeline = new ArticleTimelineView();
        primaryContent.appendChild(articleTimeline.getElement());
        break;
      }

      case 'tribes': {
        const { TribeView } = await import('./lists/tribes');
        const tribeView = new TribeView();
        primaryContent.appendChild(tribeView.getElement());
        break;
      }

      case 'mute-list': {
        const { MuteListView } = await import('./lists/mutes');
        const muteListView = new MuteListView();
        primaryContent.appendChild(await muteListView.render());
        break;
      }

      case 'messages': {
        const { MessagesView } = await import('./components/views/MessagesView');
        const messagesView = new MessagesView();
        primaryContent.appendChild(messagesView.getElement());
        break;
      }

      case 'conversation':
        if (param) {
          const { ConversationView } = await import('./components/views/ConversationView');
          const conversationView = new ConversationView(param);
          primaryContent.appendChild(conversationView.getElement());
        }
        break;
    }
  }

  private setupUI(): void {
    if (!this.appElement) return;

    this.mainLayout = new MainLayout();
    this.appElement.appendChild(this.mainLayout.getElement());
  }

  private setupEventListeners(): void {
    window.addEventListener('resize', this.handleResize.bind(this));
    document.addEventListener('visibilitychange', this.handleVisibilityChange.bind(this));
    this.setupExternalLinkHandler();
    this.setupHashtagClickHandler();
    this.setupDeepLinkHandler();

    this.eventBus.on('user:login', this.handleUserLogin.bind(this));

    this.eventBus.on('relays:updated', () => {
      if (this.timelineUI) {
        this.timelineUI.destroy();
        this.timelineUI = null;
        this.mountPrimaryContent('timeline');
      }
    });

    this.eventBus.on('user:logout', () => {
      if (this.timelineUI) {
        this.timelineUI.destroy();
        this.timelineUI = null;
      }
      this.router.navigate('/login');
    });

    // AuthGuard emits this when user tries protected action without login
    this.eventBus.on('auth:login-required', (data: { action: string }) => {
      this.showLoginRequiredModal(data.action);
    });

    this.setupTauriCloseHandler();
  }

  private async setupDeepLinkHandler(): Promise<void> {
    if (!PlatformService.getInstance().isTauri) return;

    try {
      const { onOpenUrl } = await import('@tauri-apps/plugin-deep-link');

      await onOpenUrl((urls) => {
        if (urls.length === 0) return;

        const url = urls[0];
        if (!url) return;

        try {
          let nip19String: string = url;
          if (url.startsWith('nostr:')) {
            nip19String = url.slice(6);
          }

          const decoded = decodeNip19(nip19String);
          const type = decoded.type;

          // Profile types: npub, nprofile
          if (type === 'npub' || type === 'nprofile') {
            const npub = type === 'npub'
              ? nip19String
              : hexToNpub((decoded.data as { pubkey: string }).pubkey);
            if (npub) {
              this.router.navigate(`/profile/${npub}`);
            }
            return;
          }

          // Note types: note, nevent
          if (type === 'note' || type === 'nevent') {
            const noteId = type === 'note'
              ? nip19String
              : `note1${(decoded.data as { id: string }).id}`;
            this.router.navigate(`/note/${noteId}`);
            return;
          }

          // Article type: naddr
          if (type === 'naddr') {
            this.router.navigate(`/article/${nip19String}`);
          }
        } catch {
          this.systemLogger.warn('Deep Link', `Failed to handle nostr: URL: ${url}`);
        }
      });
    } catch {
      // Deep link handler setup failed - expected in non-Tauri environments
    }
  }

  private async setupTauriCloseHandler(): Promise<void> {
    if (!PlatformService.getInstance().isTauri) return;

    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const appWindow = getCurrentWindow();

      await appWindow.onCloseRequested(async (event) => {
        const authMethod = this.authService.getAuthMethod();

        if (authMethod !== 'key-signer') return;

        event.preventDefault();

        const keySignerClient = KeySignerClient.getInstance();
        const isDaemonRunning = await keySignerClient.isRunning();

        if (!isDaemonRunning) {
          await appWindow.close();
          return;
        }

        const modalService = ModalService.getInstance();
        const shouldStopDaemon = await modalService.confirm({
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

        await appWindow.close();
      });
    } catch {
      // Tauri close handler setup failed - expected in non-Tauri environments
    }
  }

  // Intentionally empty - CSS handles responsive layout
  private handleResize(): void {}

  // Intentionally empty - subscriptions are lightweight, no pause needed
  private handleVisibilityChange(): void {}

  private setupExternalLinkHandler(): void {
    document.addEventListener('click', async (event) => {
      const target = event.target as HTMLElement;
      const anchor = target.closest('a');
      if (!anchor) return;

      const href = anchor.getAttribute('href');
      if (!href || (!href.startsWith('http://') && !href.startsWith('https://'))) return;

      event.preventDefault();

      try {
        if (PlatformService.getInstance().isTauri) {
          const { open } = await import('@tauri-apps/plugin-shell');
          await open(href);
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

  /**
   * Helper to run async initialization tasks that can fail silently
   */
  private async runSilent(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch {
      // Initialization failed - non-critical
    }
  }

  private showLoginRequiredModal(actionDescription: string): void {
    const modalContent = `
      <div class="auth-required-modal">
        <div class="auth-required-modal__icon">🔒</div>
        <h3>Login Required</h3>
        <p>Please log in to ${actionDescription}.</p>
        <div class="auth-required-modal__actions">
          <button class="btn" data-action="close">OK</button>
        </div>
      </div>
    `;

    const modalService = ModalService.getInstance();
    modalService.show({
      title: 'Authentication Required',
      content: modalContent,
      width: '400px',
      showCloseButton: true,
      closeOnOverlay: true,
      closeOnEsc: true
    });

    const closeBtn = document.querySelector('[data-action="close"]');
    closeBtn?.addEventListener('click', () => modalService.hide());
  }

  private async handleUserLogin(data: { npub: string; pubkey: string }): Promise<void> {
    // Only navigate if we're actually on /login page (user manually logged in)
    const currentPath = this.router.getCurrentPath();
    const lastURL = this.router.getLastURL();

    if (currentPath === '/login' && (!lastURL || lastURL === '/login')) {
      this.router.navigate('/');
    }

    // Check if localStorage has data from a different user (handles cross-session account switch)
    const lastLoggedInPubkey = localStorage.getItem('noornote_last_logged_in_pubkey');
    if (lastLoggedInPubkey && lastLoggedInPubkey !== data.pubkey) {
      const { CacheManager } = await import('./services/CacheManager');
      CacheManager.getInstance().clearUserSpecificCaches();
    }
    localStorage.setItem('noornote_last_logged_in_pubkey', data.pubkey);

    // Reset TimelineUI on account switch (different user)
    if (this.timelineUI && lastLoggedInPubkey && lastLoggedInPubkey !== data.pubkey) {
      this.timelineUI.destroy();
      this.timelineUI = null;

      // Re-mount timeline if currently on timeline route
      if (currentPath === '/' || currentPath === '/timeline') {
        this.mountPrimaryContent('timeline');
      }
    }

    // Load follow list into AppState (for mention autocomplete)
    await this.runSilent(async () => {
      const { UserService } = await import('./services/UserService');
      const { MentionProfileCache } = await import('./services/MentionProfileCache');

      const userService = UserService.getInstance();
      const mentionCache = MentionProfileCache.getInstance();

      const followingPubkeys = await userService.getUserFollowing(data.pubkey);

      this.appState.setState('user', { followingPubkeys });

      // Preload profiles in background (non-blocking)
      mentionCache.preloadProfiles(followingPubkeys).catch(() => {});
    });

    // Start notification services
    await this.runSilent(async () => {
      const { NotificationsOrchestrator } = await import('./services/orchestration/NotificationsOrchestrator');
      const notificationsOrch = NotificationsOrchestrator.getInstance();
      await notificationsOrch.start();

      const { ArticleNotificationService } = await import('./services/ArticleNotificationService');
      ArticleNotificationService.getInstance().startPolling();
    });

    // Start hashtag notification polling (separate block to avoid being blocked by above)
    await this.runSilent(async () => {
      const { HashtagNotificationService } = await import('./services/HashtagNotificationService');
      HashtagNotificationService.getInstance().startPolling();
    });

    // Initialize ProfileRecognitionService
    await this.runSilent(async () => {
      const { ProfileRecognitionService } = await import('./services/ProfileRecognitionService');
      await ProfileRecognitionService.getInstance().init();
    });

    // Start DM service
    await this.runSilent(async () => {
      const { DMService } = await import('./services/dm/DMService');
      await DMService.getInstance().start();
    });
  }
}

// Global type declarations for Vite environment variables
declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;
