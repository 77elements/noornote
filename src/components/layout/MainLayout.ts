/**
 * Main Layout Component
 * CSS Grid-based 3-column layout: Sidebar + Primary + Secondary
 */

import { AuthComponent } from '../auth/AuthComponent';
import { SystemLogger } from '../system/SystemLogger';
import { AccountSwitcher } from '../ui/AccountSwitcher';
import { CacheManager } from '../../services/CacheManager';
import { AppState } from '../../services/AppState';
import { Router } from '../../services/Router';
import { PostNoteModal } from '../post/PostNoteModal';
import { ModalService } from '../../services/ModalService';
import { AuthStateManager } from '../../services/AuthStateManager';
import { AuthService } from '../../services/AuthService';
import { EventBus } from '../../services/EventBus';
import { WalletBalanceDisplay } from '../ui/WalletBalanceDisplay';
import { SearchSpotlight } from '../navigation/SearchSpotlight';
import { KeyboardShortcutManager } from '../../services/KeyboardShortcutManager';
import { GlobalSearchView } from '../search/GlobalSearchView';
import { BookmarkSecondaryManager } from './managers/BookmarkSecondaryManager';
import { FollowListSecondaryManager } from './managers/FollowListSecondaryManager';
import { MuteListSecondaryManager } from './managers/MuteListSecondaryManager';
import { TribeSecondaryManager } from './managers/TribeSecondaryManager';
import { NotificationsBadgeManager } from './managers/NotificationsBadgeManager';
import { DMBadgeManager } from './managers/DMBadgeManager';
import { ListViewPartial, type ListType } from './partials/ListViewPartial';
import { ListsMenuPartial } from './partials/ListsMenuPartial';
import { deactivateAllTabs, switchTabWithContent } from '../../helpers/TabsHelper';

export class MainLayout {
  private element: HTMLElement;
  private systemLogger: SystemLogger;
  private userStatus: AccountSwitcher | null = null;
  private searchSpotlight: SearchSpotlight | null = null;
  private keyboardShortcutManager: KeyboardShortcutManager;
  private authComponent: any = null; // Store reference to trigger logout
  private cacheManager: CacheManager;
  private appState: AppState;
  private authStateManager: AuthStateManager;
  private authService: AuthService;
  private eventBus: EventBus;
  private cacheSizeUpdateInterval: number | null = null;
  private authStateUnsubscribe: (() => void) | null = null;
  private walletBalanceDisplay: WalletBalanceDisplay | null = null;
  private globalSearchView: GlobalSearchView | null = null;
  private bookmarkManager: BookmarkSecondaryManager | null = null;
  private followManager: FollowListSecondaryManager | null = null;
  private muteManager: MuteListSecondaryManager | null = null;
  private tribeManager: TribeSecondaryManager | null = null;
  private badgeManager: NotificationsBadgeManager | null = null;
  private listsMenu: ListsMenuPartial | null = null;
  private currentListView: ListViewPartial | null = null;

  constructor() {
    this.element = this.createElement();
    this.systemLogger = SystemLogger.getInstance();
    this.cacheManager = CacheManager.getInstance();
    this.appState = AppState.getInstance();
    this.authStateManager = AuthStateManager.getInstance();
    this.authService = AuthService.getInstance();
    this.eventBus = EventBus.getInstance();
    this.setupNavigationLinks();
    this.setupScrollListener();
    this.setupTabSwitching();
    this.setupMentionLinks();
    this.initializeContent();
    this.startCacheSizeUpdates();
    this.setupAuthStateListener();
    this.initializeManagers();
    this.initializeWalletBalance();
    this.setupKeyboardShortcuts();
    this.setupSpacebarScroll();
    this.initializeGlobalSearchView();
    this.setupActiveNavigation();
  }

  /**
   * Setup spacebar scrolling for primary content
   */
  private setupSpacebarScroll(): void {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !this.isInputFocused()) {
        e.preventDefault();
        const primaryContent = document.querySelector('.primary-content');
        if (primaryContent) {
          const scrollAmount = e.shiftKey ? -window.innerHeight * 0.9 : window.innerHeight * 0.9;
          primaryContent.scrollBy({ top: scrollAmount, behavior: 'smooth' });
        }
      }
    });
  }

  /**
   * Check if an input element is focused
   */
  private isInputFocused(): boolean {
    const activeElement = document.activeElement;
    return activeElement instanceof HTMLInputElement ||
           activeElement instanceof HTMLTextAreaElement ||
           (activeElement instanceof HTMLElement && activeElement.isContentEditable);
  }

  /**
   * Setup keyboard shortcuts
   */
  private setupKeyboardShortcuts(): void {
    console.log('[MainLayout] Setting up keyboard shortcuts');
    this.keyboardShortcutManager = KeyboardShortcutManager.getInstance();
    this.keyboardShortcutManager.registerSearchModalCallback(() => {
      console.log('[MainLayout] Search modal callback triggered');
      this.openSearchModal();
    });
    console.log('[MainLayout] Keyboard shortcuts setup complete');
  }

  /**
   * Initialize managers (Bookmark, Follow, Mute, Tribe, Badge, Lists Menu)
   */
  private initializeManagers(): void {
    // Initialize list managers
    this.bookmarkManager = new BookmarkSecondaryManager(this.element);
    this.followManager = new FollowListSecondaryManager(this.element);
    this.muteManager = new MuteListSecondaryManager(this.element);
    this.tribeManager = new TribeSecondaryManager(this.element);

    // Initialize NotificationsBadgeManager
    const badgeElement = this.element.querySelector('.notifications-badge') as HTMLElement;
    if (badgeElement) {
      this.badgeManager = new NotificationsBadgeManager(badgeElement);
    }

    // Initialize DMBadgeManager
    const dmBadgeElement = this.element.querySelector('.dm-badge') as HTMLElement;
    if (dmBadgeElement) {
      new DMBadgeManager(dmBadgeElement);
    }

    // Initialize Lists Menu (Sidebar Accordion)
    this.listsMenu = new ListsMenuPartial({
      onListClick: (listType) => this.openListTab(listType)
    });

    const listsMenuContainer = this.element.querySelector('.primary-nav');
    if (listsMenuContainer) {
      // Insert after Settings link (before Cache link)
      const cacheLink = listsMenuContainer.querySelector('.clear-cache-link')?.parentElement;
      if (cacheLink) {
        listsMenuContainer.insertBefore(this.listsMenu.createElement(), cacheLink);
      } else {
        listsMenuContainer.appendChild(this.listsMenu.createElement());
      }
    }

    // Listen for list:open events from Settings → Privacy links
    this.eventBus.on('list:open', (data: { listType: ListType }) => {
      this.openListTab(data.listType);
    });
  }

  /**
   * Initialize wallet balance display
   */
  private initializeWalletBalance(): void {
    const walletBalanceContainer = this.element.querySelector('.wallet-balance-container');
    if (walletBalanceContainer) {
      this.walletBalanceDisplay = new WalletBalanceDisplay();
      walletBalanceContainer.appendChild(this.walletBalanceDisplay.getElement());
    }
  }

  /**
   * Initialize search modal
   */
  private initializeSearchModal(): void {
    this.searchSpotlight = new SearchSpotlight();
  }

  /**
   * Initialize global search view
   */
  private initializeGlobalSearchView(): void {
    this.globalSearchView = new GlobalSearchView();

    // Mount in secondary content
    const secondaryContent = this.element.querySelector('.secondary-content-body');
    if (secondaryContent) {
      secondaryContent.appendChild(this.globalSearchView.getElement());
    }
  }

  /**
   * Setup active navigation highlighting
   */
  private setupActiveNavigation(): void {
    // Update on route changes
    window.addEventListener('router:view-changed', ((e: CustomEvent) => {
      this.updateActiveNavigation(e.detail?.view || '');
    }) as EventListener);

    // Set Timeline as active by default (it's the default route)
    // Will be updated by router:view-changed event when navigating
    const homeLink = this.element.querySelector('.primary-nav .home-link');
    homeLink?.classList.add('is-active');
  }

  /**
   * Update active navigation based on view class (e.g., 'tv', 'pv', 'nv')
   */
  private updateActiveNavigation(viewClass: string): void {
    // Clear all active states (main nav only, not sublinks)
    const navLinks = this.element.querySelectorAll('.primary-nav > li > a');
    navLinks.forEach(link => link.classList.remove('is-active'));

    // Map viewClass abbreviations to nav selectors
    const viewToSelector: Record<string, string> = {
      'tv': '.home-link',           // Timeline View
      'pv': '.profile-link',        // Profile View
      'nv': '.notifications-link',  // Notifications View
      'atv': 'a[href="/articles"]', // Articles Timeline View
      'av': 'a[href="/articles"]',  // Article View (single)
      'aev': 'a[href="/articles"]', // Article Editor View
      'mv': 'a[href="/messages"]',  // Messages View
      'cv': 'a[href="/messages"]',  // Conversation View
      'sv': 'a[href="/settings"]'   // Settings View
    };

    const selector = viewToSelector[viewClass];
    if (selector) {
      const activeLink = this.element.querySelector(`.primary-nav ${selector}`);
      activeLink?.classList.add('is-active');
    }
  }

  /**
   * Set active state on a list sublink
   */
  private setActiveListSublink(listType: ListType | null): void {
    // Clear all list sublinks
    const sublinks = this.element.querySelectorAll('.primary-nav__sublink');
    sublinks.forEach(link => link.classList.remove('is-active'));

    if (listType) {
      const activeSublink = this.element.querySelector(`.primary-nav__sublink[data-list-type="${listType}"]`);
      activeSublink?.classList.add('is-active');
    }
  }

  /**
   * Open search modal
   */
  private openSearchModal(): void {
    if (!this.searchSpotlight) {
      this.initializeSearchModal();
    }
    this.searchSpotlight?.open();
  }


  /**
   * Setup auth state listener to sync user status with login/logout
   */
  private setupAuthStateListener(): void {
    this.authStateUnsubscribe = this.authStateManager.subscribe((isLoggedIn) => {
      if (isLoggedIn) {
        // User logged in - set user status if we have current user
        const currentUser = this.authService.getCurrentUser();
        if (currentUser) {
          this.setUserStatus(currentUser.npub, currentUser.pubkey);
        }
      } else {
        // User logged out - clear user status
        this.clearUserStatus();
      }
    });

    // Listen for account switches (user:login fires when switching accounts)
    this.eventBus.on('user:login', (data: { npub: string; pubkey: string }) => {
      // Update AccountSwitcher with new user
      if (this.userStatus) {
        this.userStatus.updateUser({
          npub: data.npub,
          pubkey: data.pubkey,
          onLogout: () => this.handleLogout(),
          onAddAccount: () => this.handleAddAccount()
        });
      }

      // Update profile link in sidebar
      const profileLink = this.element.querySelector('.sidebar .profile-link') as HTMLAnchorElement;
      if (profileLink) {
        profileLink.href = `/profile/${data.npub}`;
      }
    });
  }

  /**
   * Setup mention links (profile links in note content) to use router
   * Uses event delegation to catch all clicks on <a href="/profile/..."> and other internal links
   */
  private setupMentionLinks(): void {
    document.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      // Check if clicked element or its parent is an internal link
      const link = target.closest('a[href^="/profile/"]') as HTMLAnchorElement;
      if (!link) return;

      e.preventDefault();
      const href = link.getAttribute('href');
      if (href) {
        Router.getInstance().navigate(href);
      }
    });
  }

  /**
   * Setup navigation links to use router instead of page reload
   */
  private setupNavigationLinks(): void {
    const homeLink = this.element.querySelector('.sidebar .home-link');
    if (homeLink) {
      homeLink.addEventListener('click', (e) => {
        e.preventDefault();
        this.handleHomeClick();
      });
    }

    const scrollToTopBtn = this.element.querySelector('.scroll-to-top-btn');
    if (scrollToTopBtn) {
      scrollToTopBtn.addEventListener('click', () => {
        this.scrollToTop();
      });
    }

    const notificationsLink = this.element.querySelector('.sidebar .notifications-link');
    if (notificationsLink) {
      notificationsLink.addEventListener('click', (e) => {
        e.preventDefault();
        const router = Router.getInstance();
        router.navigate('/notifications');
      });
    }

    const messagesLink = this.element.querySelector('.sidebar a[href="/messages"]');
    if (messagesLink) {
      messagesLink.addEventListener('click', (e) => {
        e.preventDefault();
        const router = Router.getInstance();
        router.navigate('/messages');
      });
    }

    const settingsLink = this.element.querySelector('.sidebar a[href="/settings"]');
    if (settingsLink) {
      settingsLink.addEventListener('click', (e) => {
        e.preventDefault();
        const router = Router.getInstance();
        router.navigate('/settings');
      });
    }

    const aboutLink = this.element.querySelector('.sidebar a[href="/about"]');
    if (aboutLink) {
      aboutLink.addEventListener('click', (e) => {
        e.preventDefault();
        const router = Router.getInstance();
        router.navigate('/about');
      });
    }

    const articlesLink = this.element.querySelector('.sidebar a[href="/articles"]');
    if (articlesLink) {
      articlesLink.addEventListener('click', (e) => {
        e.preventDefault();
        const router = Router.getInstance();
        router.navigate('/articles');
      });
    }

    const profileLink = this.element.querySelector('.sidebar .profile-link');
    if (profileLink) {
      profileLink.addEventListener('click', (e) => {
        e.preventDefault();
        const currentUser = this.authService.getCurrentUser();
        if (currentUser) {
          const router = Router.getInstance();
          router.navigate(`/profile/${currentUser.npub}`);
        }
      });
    }

    const searchLink = this.element.querySelector('.sidebar .search-link');
    if (searchLink) {
      searchLink.addEventListener('click', (e) => {
        e.preventDefault();
        this.openSearchModal();
      });
    }

    const clearCacheLink = this.element.querySelector('.sidebar .clear-cache-link');
    if (clearCacheLink) {
      clearCacheLink.addEventListener('click', (e) => {
        e.preventDefault();
        this.handleClearCache();
      });
    }

    // New Post Dropup
    this.setupNewPostDropup();
  }

  /**
   * Handle home link click - scroll to top if in timeline, otherwise navigate
   */
  private handleHomeClick(): void {
    const router = Router.getInstance();
    const currentPath = router.getCurrentPath();

    // Check if already on timeline (home page)
    if (currentPath === '/' || currentPath === '/timeline') {
      // Already in timeline - scroll to top
      this.scrollToTop();
    } else {
      // Navigate to timeline
      router.navigate('/');
    }
  }

  /**
   * Scroll timeline to top
   */
  private scrollToTop(): void {
    const primaryContent = this.element.querySelector('.primary-content');
    if (primaryContent) {
      primaryContent.scrollTo({ top: 0, behavior: 'smooth' });
      // Reset scroll position in CSM
      this.appState.setState('timeline', { scrollPosition: 0 });
    }
  }

  /**
   * Setup scroll listener for scroll-to-top button visibility
   */
  private setupScrollListener(): void {
    // Wait for element to be mounted
    setTimeout(() => {
      const primaryContent = this.element.querySelector('.primary-content');
      const scrollToTopBtn = this.element.querySelector('.scroll-to-top-btn') as HTMLElement;

      if (primaryContent && scrollToTopBtn) {
        primaryContent.addEventListener('scroll', () => {
          const currentView = this.appState.getState('view').currentView;
          const scrollPosition = primaryContent.scrollTop;

          // Show button if in timeline and scrolled down (> 100px)
          if (currentView === 'timeline' && scrollPosition > 100) {
            scrollToTopBtn.style.display = 'inline-block';
          } else {
            scrollToTopBtn.style.display = 'none';
          }
        });
      }
    }, 100);
  }

  /**
   * Setup tab switching in aside.secondary-content
   * Note: List tabs (Bookmarks/Follows/Mutes) are handled dynamically via openListTab()
   */
  private setupTabSwitching(): void {
    // Only setup System Logs tab (static tab)
    // List tabs are created dynamically and have their own handlers
    const secondaryContent = this.element.querySelector('.secondary-content') as HTMLElement;
    const systemLogTab = this.element.querySelector('[data-tab="system-log"]');

    if (systemLogTab && secondaryContent) {
      systemLogTab.addEventListener('click', () => {
        console.log('[TAB CLICK] system-log');
        switchTabWithContent(secondaryContent, 'system-log');
      });
    }
  }


  /**
   * Create the main layout structure
   */
  private createElement(): HTMLElement {
    const layout = document.createElement('div');
    layout.className = 'main-layout';
    layout.innerHTML = `
      <aside class="sidebar">
        <div class="sidebar-content">
          <div class="sidebar-header">
            NoorNote
          </div>
          <div class="wallet-balance-container">
            <!-- WalletBalanceDisplay will be mounted here -->
          </div>
          <ul class="primary-nav">
            <li>
              <a href="/" class="home-link" title="Scroll to top">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                  <polyline points="9 22 9 12 15 12 15 22"></polyline>
                </svg>
                Timeline
                <svg class="scroll-to-top-btn" viewBox="0 0 176 248" fill="currentColor" style="display: none;" role="button" aria-label="Scroll to top" tabindex="0">
                  <path d="M173.5,117.5 C155.833,118.167 138.167,118.833 120.5,119.5C120.5,146.167 120.5,172.833 120.5,199.5C98.5,199.5 76.5,199.5 54.5,199.5C54.5,172.833 54.5,146.167 54.5,119.5C36.8333,118.833 19.1667,118.167 1.5,117.5C29.9251,78.3137 58.5918,39.3137 87.5,0.5C116.408,39.3137 145.075,78.3137 173.5,117.5 Z"/>
                  <path d="M54.5,211.5 C76.5,211.5 98.5,211.5 120.5,211.5C120.5,215.5 120.5,219.5 120.5,223.5C98.5,223.5 76.5,223.5 54.5,223.5C54.5,219.5 54.5,215.5 54.5,211.5 Z"/>
                  <path d="M120.5,247.5 C98.5,247.5 76.5,247.5 54.5,247.5C54.5,243.5 54.5,239.5 54.5,235.5C76.5,235.5 98.5,235.5 120.5,235.5C120.5,239.5 120.5,243.5 120.5,247.5 Z"/>
                </svg>
              </a>
            </li>
            <li>
              <a href="/profile" class="profile-link">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                  <circle cx="12" cy="7" r="4"></circle>
                </svg>
                Profile
              </a>
            </li>
            <li>
              <a href="/notifications" class="notifications-link">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
                  <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
                </svg>
                Notifications
                <span class="notifications-badge"></span>
              </a>
            </li>
            <li>
              <a href="/articles">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="16" y1="13" x2="8" y2="13"/>
                  <line x1="16" y1="17" x2="8" y2="17"/>
                </svg>
                Articles
              </a>
            </li>
            <li>
              <a href="/messages">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
                  <polyline points="22,6 12,13 2,6"></polyline>
                </svg>
                Messages
                <span class="badge dm-badge" style="display: none"></span>
              </a>
            </li>
            <li>
              <a href="/settings">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>
                  <circle cx="12" cy="12" r="3"></circle>
                </svg>
                Settings
              </a>
            </li>
            <li>
              <a href="#" class="search-link">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="11" cy="11" r="8"></circle>
                  <path d="m21 21-4.35-4.35"></path>
                </svg>
                Search
              </a>
            </li>
            <li>
              <a href="#" class="clear-cache-link">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
                Cache <span class="cache-size-display">--</span>
              </a>
            </li>
            <li class="about-link-item">
              <a href="/about" class="about-link">About</a>
            </li>
          </ul>
          <div class="new-post-dropup">
            <button class="btn btn--new-post">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 5v14M5 12h14"></path>
              </svg>
              New Post
              <svg class="dropup-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12">
                <path d="M18 15l-6-6-6 6"/>
              </svg>
            </button>
            <div class="new-post-dropup__menu">
              <button class="new-post-dropup__item" data-action="new-note">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
                Note
              </button>
              <button class="new-post-dropup__item" data-action="new-article">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="16" y1="13" x2="8" y2="13"/>
                  <line x1="16" y1="17" x2="8" y2="17"/>
                  <polyline points="10 9 9 9 8 9"/>
                </svg>
                Article
              </button>
            </div>
          </div>
          <div class="sidebar-footer">
            <div class="auth-control-container">
              <!-- Login/Logout will be mounted here -->
            </div>
          </div>
        </div>
      </aside>

      <main class="primary-content">
        <!-- Content will be dynamically updated based on auth state -->
      </main>

      <aside class="secondary-content">
        <div class="secondary-user">
          <!-- User status will be mounted here -->
        </div>
        <div id="sidebar-tabs" class="tabs">
          <button class="tab tab--active" data-tab="system-log">System Logs</button>
          <!-- List tabs (Bookmarks/Follows/Mutes) will be inserted dynamically here -->
        </div>
        <div class="secondary-content-body">
          <div class="tab-content tab-content--active" data-tab-content="system-log">
            <!-- Debug Logger will be mounted here -->
          </div>
          <!-- List content will be inserted dynamically here -->
        </div>
      </aside>
    `;

    return layout;
  }

  /**
   * Get the layout element for mounting
   */
  public getElement(): HTMLElement {
    return this.element;
  }

  /**
   * Update sidebar content
   */
  public updateSidebar(content: string): void {
    const sidebar = this.element.querySelector('.sidebar-content');
    if (sidebar) {
      sidebar.innerHTML = content;
    }
  }

  /**
   * Update primary content
   */
  public updatePrimaryContent(content: string): void {
    const primary = this.element.querySelector('.primary-content');
    if (primary) {
      primary.innerHTML = content;
    }
  }

  /**
   * Update secondary content
   */
  public updateSecondaryContent(content: string): void {
    const secondary = this.element.querySelector('.secondary-content');
    if (secondary) {
      secondary.innerHTML = content;
    }
  }

  /**
   * Set user status in secondary header
   */
  public setUserStatus(npub: string, pubkey: string): void {
    // Clean up existing user status
    if (this.userStatus) {
      this.userStatus.destroy();
    }

    // Create new account switcher with callbacks
    this.userStatus = new AccountSwitcher({
      npub,
      pubkey,
      onLogout: () => this.handleLogout(),
      onAddAccount: () => this.handleAddAccount()
    });

    // Mount in secondary user area
    const secondaryUser = this.element.querySelector('.secondary-user');
    if (secondaryUser) {
      secondaryUser.innerHTML = '';
      secondaryUser.appendChild(this.userStatus.getElement());
    }

    // Update profile link href (event listener is set up in setupNavigationLinks)
    const profileLink = this.element.querySelector('.sidebar .profile-link') as HTMLAnchorElement;
    if (profileLink) {
      profileLink.href = `/profile/${npub}`;
    }
  }

  /**
   * Handle logout from AccountSwitcher component
   */
  private handleLogout(): void {
    if (this.authComponent && this.authComponent.handleLogout) {
      // Call AuthComponent's logout method
      this.authComponent.handleLogout();
    }
  }

  /**
   * Handle add account from AccountSwitcher component
   * Shows instruction modal, then opens terminal for NoorSigner add-account
   */
  private handleAddAccount(): void {
    console.log('[MainLayout] handleAddAccount called');

    const authMethod = this.authService.getAuthMethod();

    if (authMethod === 'key-signer') {
      // NoorSigner: Show instruction modal first
      this.showAddAccountInstructions();
    } else {
      // Bunker: Navigate to login
      sessionStorage.setItem('noornote_add_account', 'true');
      const router = Router.getInstance();
      router.navigate('/login');
    }
  }

  /**
   * Show add account instructions modal for NoorSigner users
   */
  private showAddAccountInstructions(): void {
    const modalService = ModalService.getInstance();

    const content = document.createElement('div');
    content.innerHTML = `
      <p style="margin-bottom: 1rem;">
        A terminal window will open. There:
      </p>
      <ol style="margin-bottom: 1.5rem; padding-left: 1.5rem;">
        <li>Paste the nsec of the new account</li>
        <li>Set a password for this account</li>
        <li>Close the terminal</li>
        <li>Come back here and log in with NoorSigner</li>
      </ol>
      <button class="btn" data-action="confirm-add-account">OK, got it</button>
    `;

    const confirmBtn = content.querySelector('[data-action="confirm-add-account"]');
    confirmBtn?.addEventListener('click', async () => {
      modalService.hide();
      await this.launchAddAccountTerminal();
    });

    modalService.show({
      title: 'Add Account',
      content,
      width: '400px',
      height: 'auto',
      showCloseButton: true,
      closeOnOverlay: true,
      closeOnEsc: true
    });
  }

  /**
   * Launch terminal for NoorSigner add-account
   */
  private async launchAddAccountTerminal(): Promise<void> {
    // 1. Navigate to login first
    sessionStorage.setItem('noornote_add_account', 'true');
    const router = Router.getInstance();
    router.navigate('/login');

    // 2. Kill daemon and open terminal
    try {
      const { invoke } = await import('@tauri-apps/api/core');

      // Kill existing daemon
      await invoke('cancel_key_signer_launch');

      // Open terminal with add-account
      await invoke('launch_key_signer', { mode: 'add-account' });
    } catch (error) {
      console.error('[MainLayout] Failed to launch add-account terminal:', error);
    }
  }

  /**
   * Clear user status (on logout)
   */
  public clearUserStatus(): void {
    if (this.userStatus) {
      this.userStatus.destroy();
      this.userStatus = null;
    }

    const secondaryUser = this.element.querySelector('.secondary-user');
    if (secondaryUser) {
      secondaryUser.innerHTML = '';
      // Re-mount AuthComponent to show Login button again
      if (this.authComponent) {
        secondaryUser.appendChild(this.authComponent.getElement());
      }
    }

    // Reset profile link on logout (event listener remains in setupNavigationLinks)
    const profileLink = this.element.querySelector('.sidebar .profile-link') as HTMLAnchorElement;
    if (profileLink) {
      profileLink.href = '/profile';
    }
  }

  /**
   * Initialize content areas
   */
  private initializeContent(): void {
    // Mount auth component in secondary-user (top right - Login/Logout)
    this.authComponent = new AuthComponent(this);
    const secondaryUser = this.element.querySelector('.secondary-user');
    if (secondaryUser) {
      secondaryUser.appendChild(this.authComponent.getElement());
    }

    // Mount debug logger in system-log tab content
    const systemLogTab = this.element.querySelector('[data-tab-content="system-log"]');
    if (systemLogTab) {
      systemLogTab.appendChild(this.systemLogger.getElement());
    }

    // Bookmarks tab will be rendered on first click (see setupTabSwitching)

    // Add initial log messages
    this.systemLogger.info('System', 'Noornote application started');
    this.systemLogger.debug('Layout', 'MainLayout initialized with SystemLogger');
  }

  /**
   * Handle clear cache click - clears NDK cache and reloads
   */
  private async handleClearCache(): Promise<void> {
    const { ModalService } = await import('../../services/ModalService');
    const modalService = ModalService.getInstance();

    // Show confirmation modal
    modalService.show({
      title: 'Clear Cache?',
      content: `
        <div style="padding: 1rem 0;">
          <p style="margin-bottom: 1rem;">The following caches will be cleared:</p>
          <ul style="margin: 1rem 0; padding-left: 1.5rem; line-height: 1.8; font-size: 14px;">
            <li>Events (Posts, Reactions, Reposts)</li>
            <li>Profiles (User Metadata)</li>
            <li>Event Tags</li>
            <li>NIP-05 Verifications</li>
            <li>Lightning Addresses</li>
            <li>Relay Status</li>
          </ul>
          <p style="font-size: 13px; color: rgba(255, 255, 255, 0.6); margin-top: 1rem;">
            Unpublished posts and decrypted messages will remain protected.
          </p>
          <p style="font-size: 13px; color: rgba(255, 255, 255, 0.5); margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid rgba(255, 255, 255, 0.1);">
            To clear specific caches individually, go to <a href="#" data-action="settings">Cache Settings</a>.
          </p>
        </div>
        <div style="display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1.5rem;">
          <button class="btn btn--passive" data-action="cancel">Cancel</button>
          <button class="btn" data-action="confirm">Clear</button>
        </div>
      `,
      width: '500px',
      closeOnBackdrop: true,
      closeOnEsc: true
    });

    // Setup modal button handlers
    setTimeout(() => {
      const cancelBtn = document.querySelector('[data-action="cancel"]');
      const confirmBtn = document.querySelector('[data-action="confirm"]');
      const settingsLink = document.querySelector('[data-action="settings"]');

      cancelBtn?.addEventListener('click', () => {
        modalService.hide();
      });

      settingsLink?.addEventListener('click', (e) => {
        e.preventDefault();
        modalService.hide();
        const router = Router.getInstance();
        router.navigate('/settings');
      });

      confirmBtn?.addEventListener('click', async () => {
        modalService.hide();

        try {
          // Import db from NDK cache adapter
          const { db } = await import('@nostr-dev-kit/ndk-cache-dexie');

          // Clear all safe tables (exclude unpublishedEvents, decryptedEvents, eventRelays)
          await Promise.all([
            db.events.clear(),
            db.profiles.clear(),
            db.eventTags.clear(),
            db.nip05.clear(),
            db.lnurl.clear(),
            db.relayStatus.clear()
          ]);

          // Reload app
          window.location.reload();
        } catch (error) {
          console.error('Failed to clear cache:', error);
          const { ToastService } = await import('../../services/ToastService');
          ToastService.getInstance().show('Failed to clear cache', 'error');
        }
      });
    }, 100);
  }

  /**
   * Setup New Post dropup menu
   */
  private setupNewPostDropup(): void {
    const dropup = this.element.querySelector('.new-post-dropup');
    const button = dropup?.querySelector('.btn--new-post');
    const menu = dropup?.querySelector('.new-post-dropup__menu');

    if (!dropup || !button || !menu) return;

    // Toggle menu on button click
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('is-open');
    });

    // Handle menu item clicks
    const noteItem = menu.querySelector('[data-action="new-note"]');
    const articleItem = menu.querySelector('[data-action="new-article"]');

    noteItem?.addEventListener('click', () => {
      menu.classList.remove('is-open');
      const postNoteModal = PostNoteModal.getInstance();
      postNoteModal.show();
    });

    articleItem?.addEventListener('click', () => {
      menu.classList.remove('is-open');
      Router.getInstance().navigate('/write-article');
    });

    // Close menu when clicking outside
    document.addEventListener('click', (e) => {
      if (!dropup.contains(e.target as Node)) {
        menu.classList.remove('is-open');
      }
    });
  }

  /**
   * Start periodic cache size updates
   */
  private startCacheSizeUpdates(): void {
    this.updateCacheSize(); // Initial update
    this.cacheSizeUpdateInterval = window.setInterval(() => {
      this.updateCacheSize();
    }, 5000); // Update every 5 seconds
  }

  /**
   * Update cache size display in sidebar
   */
  private async updateCacheSize(): Promise<void> {
    const cacheSizeDisplay = this.element.querySelector('.cache-size-display');
    if (!cacheSizeDisplay) return;

    const stats = await this.cacheManager.getCacheStats();
    const totalCacheSize = stats.total.size;

    cacheSizeDisplay.textContent = `(${this.cacheManager.formatBytes(totalCacheSize)})`;
  }


  /**
   * Stop cache size updates
   */
  private stopCacheSizeUpdates(): void {
    if (this.cacheSizeUpdateInterval !== null) {
      clearInterval(this.cacheSizeUpdateInterval);
      this.cacheSizeUpdateInterval = null;
    }
  }

  /**
   * Show login screen (trigger AuthComponent to display login options)
   */
  public showLoginScreen(): void {
    if (this.authComponent && typeof this.authComponent.showLoginScreen === 'function') {
      this.authComponent.showLoginScreen();
    }
  }


  /**
   * Open a list tab (Bookmarks, Follows, or Muted Users)
   * Replaces any existing list tab
   */
  public openListTab(listType: ListType): void {
    // Close existing list tab if any (without clearing active state yet)
    if (this.currentListView) {
      this.currentListView.destroy();
      this.currentListView = null;
    }

    // Set active state on list sublink
    this.setActiveListSublink(listType);

    // Map list types to titles
    const titles: Record<ListType, string> = {
      bookmarks: 'List: Bookmarks',
      follows: 'List: Follows',
      mutes: 'List: Muted',
      tribes: 'List: Tribes'
    };

    // Map list types to managers
    const managers: Record<ListType, any> = {
      bookmarks: this.bookmarkManager,
      follows: this.followManager,
      mutes: this.muteManager,
      tribes: this.tribeManager
    };

    const manager = managers[listType];
    if (!manager) {
      console.error(`[MainLayout] No manager found for list type: ${listType}`);
      return;
    }

    // Create new list view
    this.currentListView = new ListViewPartial({
      type: listType,
      title: titles[listType],
      onClose: () => this.closeListTab(),
      onRender: (container) => {
        // Delegate rendering to the appropriate manager
        manager.renderListTab(container);
      }
    });

    // Insert tab and content into DOM
    const secondaryContent = this.element.querySelector('.secondary-content') as HTMLElement;
    const tabsContainer = this.element.querySelector('#sidebar-tabs');
    const contentBody = this.element.querySelector('.secondary-content-body');

    if (secondaryContent && tabsContainer && contentBody) {
      const tab = this.currentListView.createTab();
      const content = this.currentListView.createContent();

      tabsContainer.appendChild(tab);
      contentBody.appendChild(content);

      // Setup tab click handler
      tab.addEventListener('click', (e) => {
        // Ignore clicks on close button
        if ((e.target as HTMLElement).closest('.tab__close')) {
          return;
        }

        // Deactivate all tabs and activate clicked tab (scoped to secondary-content only)
        deactivateAllTabs(secondaryContent);
        this.currentListView?.activate();
      });

      // Activate the new tab (scoped to secondary-content only)
      deactivateAllTabs(secondaryContent);
      this.currentListView.activate();

      // Render content
      this.currentListView.renderContent();
    }
  }

  /**
   * Close the current list tab
   */
  public closeListTab(): void {
    if (this.currentListView) {
      this.currentListView.destroy();
      this.currentListView = null;

      // Clear active state on list sublinks
      this.setActiveListSublink(null);

      // Activate System Logs tab (scoped to secondary-content only)
      const secondaryContent = this.element.querySelector('.secondary-content') as HTMLElement;
      if (secondaryContent) {
        switchTabWithContent(secondaryContent, 'system-log');
      }
    }
  }

  /**
   * Cleanup resources
   */
  public destroy(): void {
    this.stopCacheSizeUpdates();

    // Unsubscribe from auth state
    if (this.authStateUnsubscribe) {
      this.authStateUnsubscribe();
    }

    // Destroy managers
    if (this.bookmarkManager) {
      this.bookmarkManager.destroy();
    }

    if (this.badgeManager) {
      this.badgeManager.destroy();
    }

    if (this.userStatus) {
      this.userStatus.destroy();
    }

    if (this.walletBalanceDisplay) {
      this.walletBalanceDisplay.destroy();
    }

    if (this.searchSpotlight) {
      this.searchSpotlight.destroy();
    }

    this.element.remove();
  }
}