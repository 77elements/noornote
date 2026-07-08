/**
 * Main Layout Component
 * CSS Grid-based 3-column layout: Sidebar + Primary + Secondary
 */

import { AuthComponent } from '../auth/AuthComponent';
import { OnboardingComponent } from '../onboarding/OnboardingComponent';
import { SystemLogger } from '../../services/SystemLogger';
import { AccountSwitcher } from '../ui/AccountSwitcher';
import { FontSizeSwitcher } from '../ui/FontSizeSwitcher';
import { ThemeSwitcher } from '../ui/ThemeSwitcher';
import { Switch } from '../ui/Switch';
import { isDataSaverEnabled, setDataSaverEnabled } from '../../services/DataSaverService';
import { FontSizeService } from '../../services/FontSizeService';
import { CacheManager } from '../../services/CacheManager';
import { AppState } from '../../services/AppState';
import { Router } from '../../services/Router';
// PostNoteModal loaded lazily on click (Step 4 bundle optimization)
import { ModalService } from '../../services/ModalService';
import { AuthStateManager } from '../../services/AuthStateManager';
import { AuthService } from '../../services/AuthService';
import { TypedEventBus } from '../../core/TypedEventBus';
import { getOrderedAddons, getOrderedAddonsForPubkey } from '../../addons/addonOrder';
import { wireAddonReorder } from './AddonNavReorder';
// WalletBalanceDisplay is owned by src/addons/wallet-balance/runtime.ts and
// managed by the AddonLoader. MainLayout only provides the mount point
// (.wallet-balance-container, see this.element template).
// SearchSpotlight loaded lazily on Cmd+K (Step 6 bundle optimization)
type SearchSpotlight = import('../navigation/SearchSpotlight').SearchSpotlight;
import { KeyboardShortcutManager } from '../../services/KeyboardShortcutManager';
// GlobalSearchView loaded lazily (Step 6 bundle optimization)
type GlobalSearchView = import('../search/GlobalSearchView').GlobalSearchView;
// List managers loaded lazily (Step 3 bundle optimization)
type BookmarkManager = import('../../lists/bookmarks').BookmarkManager;
type FollowListManager = import('../../lists/follows').FollowListManager;
type MuteListManager = import('../../lists/mutes').MuteListManager;
type TribeManager = import('../../lists/tribes').TribeManager;
import { NotificationsBadgeManager } from './managers/NotificationsBadgeManager';
import { DMBadgeManager } from './managers/DMBadgeManager';
import { HamburgerBadgeManager } from './managers/HamburgerBadgeManager';
import { ListViewPartial, type ListType } from './partials/ListViewPartial';
import { SccArticleFeed } from './partials/SccArticleFeed';
import { SccMediaFeed } from './partials/SccMediaFeed';
import { ListsMenuPartial } from './partials/ListsMenuPartial';
import { deactivateAllTabs, switchTabWithContent, createClosableTab } from '../../helpers/TabsHelper';
import { RailFlyout } from '../../helpers/RailFlyout';
import { ViewTabManager, type ViewTab } from '../../services/ViewTabManager';
import { PerAccountLocalStorage, StorageKeys } from '../../services/PerAccountLocalStorage';
import { CustomDropdown } from '../ui/CustomDropdown';
import { getSccDefaultTab, setSccDefaultTab, type SccDefaultContent } from '../../helpers/sccDefaultTab';
import { LayoutService } from '../../services/LayoutService';
import { PlatformService } from '../../services/PlatformService';
import { PullToRefresh } from '../ui/PullToRefresh';
import { getViewNavigationController } from '../../services/ViewNavigationController';
import { writeSccParam, readSccParam, parseSccParam, viewTypeToPath, userListToScc } from '../../helpers/sccRoute';
// dayjs + calendar loaded lazily in initializeDateTimeCalendar (bundle optimization)
import { HIJRI_MONTHS } from '../../helpers/formatTimestamp';

// Global type declaration for Vite environment variable
declare const __APP_VERSION__: string;

export class MainLayout {
  private element: HTMLElement;
  private systemLogger: SystemLogger;
  private userStatus: AccountSwitcher | null = null;
  private fontSizeSwitcher: FontSizeSwitcher | null = null;
  private themeSwitcher: ThemeSwitcher | null = null;
  private searchSpotlight: SearchSpotlight | null = null;
  private keyboardShortcutManager!: KeyboardShortcutManager;
  private authComponent: any = null; // Store reference to trigger logout
  private onboardingComponent: OnboardingComponent | null = null;
  private cacheManager: CacheManager;
  private appState: AppState;
  private authStateManager: AuthStateManager;
  private authService: AuthService;
  private eventBus: TypedEventBus;
  private cacheSizeUpdateInterval: number | null = null;
  private dateTimeUpdateInterval: number | null = null;
  private authStateUnsubscribe: (() => void) | null = null;
  private globalSearchView: GlobalSearchView | null = null;
  private bookmarkManager: BookmarkManager | null = null;
  private followManager: FollowListManager | null = null;
  private muteManager: MuteListManager | null = null;
  private tribeManager: TribeManager | null = null;
  private badgeManager: NotificationsBadgeManager | null = null;
  private hamburgerBadgeManager: HamburgerBadgeManager | null = null;
  private listsMenu: ListsMenuPartial | null = null;
  private currentListView: ListViewPartial | null = null;
  /**
   * Tracks an open external user-list (a target's follows/followers) so syncScc
   * can mirror it into `?scc=` with its pubkey — the DOM tab id alone (`list-follows`)
   * carries neither the target nor the follows/followers distinction.
   */
  private externalUserList: { mode: 'follows' | 'followers'; pubkey: string } | null = null;
  /**
   * The currently-active ExternalFollowListManager instance (if any). Tracked
   * so its background follower-sweep can be torn down (destroy()) when the tab
   * is closed or replaced — otherwise the streaming keeps running against a
   * detached DOM node (memory leak + wasted relay queries). Typed structurally
   * since the class is dynamically imported.
   */
  private externalFollowManager: { destroy(): void } | null = null;
  private viewTabManager: ViewTabManager | null = null;
  private viewTabEventSubscriptions: string[] = [];
  private sidebarTabsWheelCleanup: (() => void) | null = null;
  private layoutService: LayoutService;
  private pullToRefresh: PullToRefresh | null = null;
  private sccDefaultDropdown: CustomDropdown | null = null;
  private sccArticleFeed: SccArticleFeed | null = null;
  private sccMediaFeed: SccMediaFeed | null = null;
  private _dayjs: any = null;

  constructor() {
    this.element = this.createElement();
    this.systemLogger = SystemLogger.getInstance();
    this.cacheManager = CacheManager.getInstance();
    this.appState = AppState.getInstance();
    this.authStateManager = AuthStateManager.getInstance();
    this.authService = AuthService.getInstance();
    this.eventBus = TypedEventBus.getInstance();
    this.layoutService = LayoutService.getInstance();
    this.setupNavigationLinks();
    this.setupSidebarCollapse();
    this.setupMobileSidebar();
    this.setupPullToRefresh();
    this.setupScrollListener();
    this.setupTabSwitching();
    this.setupMentionLinks();
    this.initializeContent();
    this.startCacheSizeUpdates();
    this.setupAuthStateListener();
    this.initializeManagers();
    // wallet-balance is managed by AddonLoader + src/addons/wallet-balance/runtime.ts
    this.setupKeyboardShortcuts();
    this.setupSpacebarScroll();
    this.initializeGlobalSearchView();
    this.setupActiveNavigation();
    this.initializeViewTabManager();
    this.initializeDateTimeCalendar();
    this.startDateTimeUpdates();
  }

  /**
   * Setup spacebar scrolling for primary content
   */
  private setupSpacebarScroll(): void {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !this.isInputFocused()) {
        e.preventDefault();
        const scrollContainer = document.querySelector('.timeline-view__timeline') || document.querySelector('.primary-content');
        if (scrollContainer) {
          const scrollAmount = e.shiftKey ? -window.innerHeight * 0.9 : window.innerHeight * 0.9;
          scrollContainer.scrollBy({ top: scrollAmount, behavior: 'smooth' });
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
    this.keyboardShortcutManager = KeyboardShortcutManager.getInstance();
    this.keyboardShortcutManager.registerSearchModalCallback(() => {
      this.openSearchModal();
    });
  }

  /**
   * Initialize managers (Bookmark, Follow, Mute, Tribe, Badge, Lists Menu)
   */
  private async loadListManagers(): Promise<void> {
    const [{ FollowListManager }, { MuteListManager }] = await Promise.all([
      import('../../lists/follows'),
      import('../../lists/mutes')
    ]);
    this.followManager = new FollowListManager(this.element);
    this.muteManager = new MuteListManager(this.element);

    // Bookmarks addon: lazy-load only when enabled
    const { isBookmarksEnabled } = await import('../../addons/bookmarks/index');
    if (isBookmarksEnabled()) {
      const { BookmarkManager } = await import('../../lists/bookmarks');
      this.bookmarkManager = new BookmarkManager(this.element);
    }

    // Tribes addon: lazy-load only when enabled
    const { isTribesEnabled } = await import('../../addons/tribes/index');
    if (isTribesEnabled()) {
      const { TribeManager } = await import('../../lists/tribes');
      this.tribeManager = new TribeManager(this.element);
    }

  }

  private initializeManagers(): void {
    // Lazy-load list managers (they pull in heavy deps)
    this.loadListManagers();
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

    // Initialize HamburgerBadgeManager (phone mode notification dot)
    const hamburgerBadgeElement = this.element.querySelector('.hamburger-badge') as HTMLElement;
    if (hamburgerBadgeElement) {
      this.hamburgerBadgeManager = new HamburgerBadgeManager(hamburgerBadgeElement);
    }

    // Initialize Lists Menu (Sidebar Accordion)
    this.listsMenu = new ListsMenuPartial({
      onListClick: (listType) => this.openListTab(listType)
    });

    const listsMenuContainer = this.element.querySelector('.primary-nav');
    if (listsMenuContainer) {
      // Insert after Settings link (before Download link)
      const downloadLink = listsMenuContainer.querySelector('.primary-nav__link--download')?.parentElement;
      if (downloadLink) {
        listsMenuContainer.insertBefore(this.listsMenu.createElement(), downloadLink);
      } else {
        listsMenuContainer.appendChild(this.listsMenu.createElement());
      }
    }

    // Addons: always-visible sidebar entry
    this.insertAddonsSidebarEntry(listsMenuContainer);

    // Bookmarks toggle: show/hide sidebar entry + lazy-load manager + close open tab
    this.eventBus.on('bookmarks:addon-toggle', async (data: { enabled: boolean }) => {
      const menuItem = this.element.querySelector('.bookmarks-item') as HTMLElement;
      if (menuItem) {
        menuItem.style.display = data.enabled ? '' : 'none';
      }
      if (data.enabled && !this.bookmarkManager) {
        const { BookmarkManager } = await import('../../lists/bookmarks');
        this.bookmarkManager = new BookmarkManager(this.element);
        // Sync from relays after 10s (like startup sync) to pull existing data
        const { AutoSyncService } = await import('../../services/AutoSyncService');
        AutoSyncService.getInstance().scheduleSyncForList('bookmarks');
      }
      if (!data.enabled && this.currentListView?.getType() === 'bookmarks') {
        this.closeListTab();
      }
    });

    // Tribes toggle: show/hide sidebar entry + lazy-load manager + close open tab
    this.eventBus.on('tribes:addon-toggle', async (data: { enabled: boolean }) => {
      const menuItem = this.element.querySelector('.tribes-item') as HTMLElement;
      if (menuItem) {
        menuItem.style.display = data.enabled ? '' : 'none';
      }
      if (data.enabled && !this.tribeManager) {
        const { TribeManager } = await import('../../lists/tribes');
        this.tribeManager = new TribeManager(this.element);
        // Sync from relays after 10s (like startup sync) to pull existing data
        const { AutoSyncService } = await import('../../services/AutoSyncService');
        AutoSyncService.getInstance().scheduleSyncForList('tribes');
      }
      if (!data.enabled && this.currentListView?.getType() === 'tribes') {
        this.closeListTab();
      }
    });



    // Listen for list:open events from Settings → Privacy links, ProfileView, FollowPackDetailView
    this.eventBus.on('list:open', (data) => {
      // Followers: always an external read-only list (even for the own profile).
      if (data.listType === 'followers' && data.pubkey) {
        this.openExternalUserListTab(data.pubkey, 'followers');
        return;
      }
      // Another user's follows open as a read-only list; the own follows use the
      // editable list tab.
      const currentUser = this.authService.getCurrentUser();
      if (data.listType === 'follows' && data.pubkey && currentUser?.pubkey !== data.pubkey) {
        this.openExternalUserListTab(data.pubkey, 'follows');
      } else {
        this.openListTab(data.listType as ListType);
      }
    });
  }

  /**
   * Initialize ViewTabManager if layout mode is 'right-pane'
   * Subscribe to TypedEventBus events for tab management
   */
  private initializeViewTabManager(): void {
    // ALWAYS subscribe to layout mode change event (even if currently disabled)
    const layoutModeChangedSub = this.eventBus.on('layout:changed', (data: { mode: string }) => {
      if (data.mode === 'right-pane' && !this.viewTabManager) {
        // Enable: Initialize manager and event handlers
        this.enableViewTabManager();
      } else if (data.mode !== 'right-pane' && this.viewTabManager) {
        // Disable: Cleanup manager
        this.disableViewTabManager();
      }
      // Re-sync the ?scc= param (clears it when leaving the scc-visible modes).
      this.syncScc();
    });
    this.viewTabEventSubscriptions.push(layoutModeChangedSub);

    // On logout, close all tabs
    const logoutSub = this.eventBus.on('user:logout', () => {
      this.viewTabManager?.closeAllTabs();
      // Stop any active external follower/following sweep so it doesn't keep
      // streaming (and hold account-specific relay subscriptions) after the
      // account is gone.
      this.destroyExternalFollowManager();
    });
    this.viewTabEventSubscriptions.push(logoutSub);

    // On login, re-check layout mode (user might have right-pane enabled)
    const loginSub = this.eventBus.on('user:login', () => {
      this.layoutService.refresh();
      FontSizeService.getInstance().refresh();
      if (this.layoutService.isRightPane() && !this.viewTabManager) {
        this.enableViewTabManager();
      }
    });
    this.viewTabEventSubscriptions.push(loginSub);

    // If right-pane mode on init, setup immediately
    if (this.layoutService.isRightPane()) {
      this.enableViewTabManager();
    }
  }

  /**
   * Enable ViewTabManager and subscribe to tab events
   */
  private enableViewTabManager(): void {
    if (this.viewTabManager) {
      return; // Already enabled
    }

    // Initialize ViewTabManager
    this.viewTabManager = ViewTabManager.getInstance();

    // Apply scrollable class to sidebar tabs + let the mouse wheel cycle the active tab
    const sidebarTabs = this.element.querySelector('#sidebar-tabs');
    if (sidebarTabs) {
      sidebarTabs.classList.add('tabs--scrollable');
      this.sidebarTabsWheelCleanup = this.setupTabWheelSwitch(sidebarTabs as HTMLElement);
    }

    // Subscribe to view-tab events
    const openedSub = this.eventBus.on('view-tab:opened', (data: { tab: ViewTab }) => {
      this.renderViewTab(data.tab);
      this.syncScc();
    });
    this.viewTabEventSubscriptions.push(openedSub);

    const closedSub = this.eventBus.on('view-tab:closed', (data: { tabId: string }) => {
      this.removeViewTab(data.tabId);
      this.syncScc();
    });
    this.viewTabEventSubscriptions.push(closedSub);

    const switchedSub = this.eventBus.on('view-tab:switched', (data: { tabId: string }) => {
      this.switchToViewTab(data.tabId);
      this.syncScc();
    });
    this.viewTabEventSubscriptions.push(switchedSub);

    const labelUpdatedSub = this.eventBus.on('view-tab:label-updated', (data: { tabId: string; label: string; pubkey?: string; profilePicUrl?: string }) => {
      this.updateViewTabLabel(data.tabId, data.label, data.pubkey, data.profilePicUrl);
    });
    this.viewTabEventSubscriptions.push(labelUpdatedSub);
  }

  /**
   * Mouse wheel over the tab strip cycles the active view tab (next on scroll down,
   * previous on scroll up). Throttled so one wheel notch advances exactly one tab.
   * Returns a cleanup function.
   */
  private setupTabWheelSwitch(strip: HTMLElement): () => void {
    let lastSwitch = 0;
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY === 0) return;
      const tabs = this.viewTabManager?.getOpenTabs() ?? [];
      if (tabs.length < 2) return;
      e.preventDefault();
      const now = e.timeStamp;
      if (now - lastSwitch < 120) return; // one notch = one tab
      lastSwitch = now;

      const activeId = this.viewTabManager?.getActiveTab()?.id;
      let idx = tabs.findIndex(t => t.id === activeId);
      if (idx === -1) idx = 0;
      const nextIdx = e.deltaY > 0
        ? Math.min(idx + 1, tabs.length - 1)
        : Math.max(idx - 1, 0);
      const next = tabs[nextIdx];
      if (next && next.id !== activeId) this.viewTabManager?.switchTab(next.id);
    };
    strip.addEventListener('wheel', onWheel, { passive: false });
    return () => strip.removeEventListener('wheel', onWheel);
  }

  /**
   * Disable ViewTabManager and cleanup
   */
  private disableViewTabManager(): void {
    if (!this.viewTabManager) return; // Already disabled

    this.viewTabManager.closeAllTabs();
    this.viewTabManager = null;

    // Remove scrollable class + detach the wheel handler
    const sidebarTabs = this.element.querySelector('#sidebar-tabs');
    if (sidebarTabs) {
      sidebarTabs.classList.remove('tabs--scrollable');
    }
    this.sidebarTabsWheelCleanup?.();
    this.sidebarTabsWheelCleanup = null;

    // Note: We keep the event subscriptions because they check if viewTabManager exists
    // Only the main subscriptions (settings change, logout) persist
  }

  /**
   * Cleanup ViewTabManager and all subscriptions (on destroy)
   */
  private cleanupViewTabManager(): void {
    if (this.viewTabManager) {
      this.viewTabManager.closeAllTabs();
      this.viewTabManager = null;
    }

    // Unsubscribe from ALL events
    this.viewTabEventSubscriptions.forEach(subId => this.eventBus.off(subId));
    this.viewTabEventSubscriptions = [];

    // Remove scrollable class + detach the wheel handler
    const sidebarTabs = this.element.querySelector('#sidebar-tabs');
    if (sidebarTabs) {
      sidebarTabs.classList.remove('tabs--scrollable');
    }
    this.sidebarTabsWheelCleanup?.();
    this.sidebarTabsWheelCleanup = null;
  }

  /**
   * Render view tab in secondary content
   */
  private renderViewTab(tab: ViewTab): void {
    const sidebarTabs = this.element.querySelector('#sidebar-tabs');
    const contentBody = this.element.querySelector('.secondary-content-body');
    if (!sidebarTabs || !contentBody) return;

    // Create tab button using TabsHelper
    const tabButton = createClosableTab(
      tab.id,
      tab.label,
      () => this.viewTabManager?.closeTab(tab.id),
      tab.profilePicUrl
    );

    sidebarTabs.appendChild(tabButton);

    // Create tab content
    const contentDiv = document.createElement('div');
    contentDiv.className = 'tab-content';
    contentDiv.dataset.tabContent = tab.id;
    contentDiv.appendChild(tab.viewInstance.getElement());
    contentBody.appendChild(contentDiv);

    // Tab click handler
    tabButton.addEventListener('click', () => {
      this.viewTabManager?.switchTab(tab.id);
    });

    // Auto-switch if active
    if (tab.isActive) {
      this.switchToViewTab(tab.id);
    }
  }

  /**
   * Remove view tab from DOM
   */
  private removeViewTab(tabId: string): void {
    this.element.querySelector(`[data-tab="${tabId}"]`)?.remove();
    this.element.querySelector(`[data-tab-content="${tabId}"]`)?.remove();
  }

  /**
   * Switch to view tab (activate)
   */
  private switchToViewTab(tabId: string): void {
    const secondaryContent = this.element.querySelector('.secondary-content') as HTMLElement;
    if (secondaryContent) {
      // Switch only direct child tabs (not nested tabs within views like MessagesView)
      const sidebarTabs = secondaryContent.querySelector('#sidebar-tabs');
      const contentBody = secondaryContent.querySelector('.secondary-content-body');

      if (sidebarTabs && contentBody) {
        // Update tabs (only direct children of #sidebar-tabs)
        sidebarTabs.querySelectorAll(':scope > .tab').forEach(tab => {
          const el = tab as HTMLElement;
          if (el.dataset.tab === tabId) {
            el.classList.add('tab--active');
          } else {
            el.classList.remove('tab--active');
          }
        });

        // Update content (only direct children of content-body)
        contentBody.querySelectorAll(':scope > .tab-content').forEach(content => {
          const el = content as HTMLElement;
          if (el.dataset.tabContent === tabId) {
            el.classList.add('tab-content--active');
          } else {
            el.classList.remove('tab-content--active');
          }
        });
      }

      // Auto-scroll tab into view (align to end = right edge)
      const tabButton = secondaryContent.querySelector(`#sidebar-tabs > [data-tab="${tabId}"]`) as HTMLElement;
      tabButton?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'end' });
    }
  }

  /**
   * Update view tab label + profile pic
   */
  private updateViewTabLabel(tabId: string, label: string, _pubkey?: string, profilePicUrl?: string): void {
    const tabButton = this.element.querySelector(`[data-tab="${tabId}"]`) as HTMLElement;
    if (!tabButton) return;

    // Update label
    const labelEl = tabButton.querySelector('.tab__label');
    if (labelEl) labelEl.textContent = label;

    // Update or add profile pic
    if (profilePicUrl) {
      let profilePic = tabButton.querySelector('.profile-pic') as HTMLImageElement;
      if (profilePic) {
        // Update existing pic
        profilePic.src = profilePicUrl;
      } else {
        // Add new pic (before label) - this makes tab wider
        profilePic = document.createElement('img');
        profilePic.className = 'profile-pic profile-pic--mini';
        profilePic.src = profilePicUrl;
        profilePic.alt = 'Profile';
        tabButton.insertBefore(profilePic, labelEl);

        // Re-scroll to end if this is the active tab (tab got wider)
        if (tabButton.classList.contains('tab--active')) {
          setTimeout(() => {
            tabButton.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'end' });
          }, 50);
        }
      }
    }
  }

  /**
   * Re-initialize addon list managers after auth is available.
   * On startup, loadListManagers() may run before auth completes,
   * causing PerAccountLocalStorage to return defaults (disabled).
   */
  private async initializeAddonsAfterAuth(): Promise<void> {
    // The sidebar entries are rendered (with a hardcoded visibility) before login,
    // when per-account storage has no pubkey yet. Now that the user is known, re-sync
    // each list entry's visibility from its real per-account enabled flag — otherwise
    // an enabled list stays hidden until the addon is toggled off and on again.

    // Bookmarks: sync sidebar visibility + load manager if enabled
    const { isBookmarksEnabled } = await import('../../addons/bookmarks/index');
    const bookmarksEnabled = isBookmarksEnabled();
    this.setListAddonVisibility('.bookmarks-item', bookmarksEnabled);
    if (bookmarksEnabled && !this.bookmarkManager) {
      const { BookmarkManager } = await import('../../lists/bookmarks');
      this.bookmarkManager = new BookmarkManager(this.element);
    }

    // Tribes: sync sidebar visibility + load manager if enabled
    const { isTribesEnabled } = await import('../../addons/tribes/index');
    const tribesEnabled = isTribesEnabled();
    this.setListAddonVisibility('.tribes-item', tribesEnabled);
    if (tribesEnabled && !this.tribeManager) {
      const { TribeManager } = await import('../../lists/tribes');
      this.tribeManager = new TribeManager(this.element);
    }
  }

  /** Show/hide a Lists submenu entry (.bookmarks-item / .tribes-item). */
  private setListAddonVisibility(selector: string, visible: boolean): void {
    const item = this.element.querySelector(selector) as HTMLElement | null;
    if (item) item.style.display = visible ? '' : 'none';
  }

  /**
   * Initialize global search view
   * Mounts in scc (default/right-pane mode) or intercepts events for pcc rendering (wide mode)
   */
  private async initializeGlobalSearchView(): Promise<void> {
    const { GlobalSearchView } = await import('../search/GlobalSearchView');
    this.globalSearchView = new GlobalSearchView();
    // The search tab activates/closes inside GlobalSearchView; let it trigger the
    // single ?scc= writer here so search state is persisted like the other tabs.
    this.globalSearchView.onSccChange = () => this.syncScc();

    // Mount in secondary content unless wide/mobile mode
    if (this.layoutService.isSecondaryVisible()) {
      const secondaryContent = this.element.querySelector('.secondary-content-body');
      if (secondaryContent) {
        secondaryContent.appendChild(this.globalSearchView.getElement());
      }
    }

    // Intercept search events for wide mode to render in pcc
    this.setupSearchEventInterceptors();

    // Listen for layout mode changes
    this.eventBus.on('layout:changed', (data: { mode: string }) => {
      if (data.mode === 'wide' || data.mode === 'mobile') {
        // Unmount from scc (search results will go to pcc via interceptors)
        if (this.globalSearchView) {
          const searchElement = this.globalSearchView.getElement();
          searchElement.remove();
        }
      } else {
        // Mount in scc (default or right-pane mode)
        const secondaryContent = this.element.querySelector('.secondary-content-body');
        if (secondaryContent && this.globalSearchView) {
          const searchElement = this.globalSearchView.getElement();
          if (!searchElement.parentElement) {
            secondaryContent.appendChild(searchElement);
          }
        }
      }
    });
  }

  /**
   * Setup search event interceptors for wide mode
   * Intercepts search events with HIGH PRIORITY (before GlobalSearchView)
   * In wide mode: Prevents GlobalSearchView from processing tab creation, renders in pcc instead
   */
  private setupSearchEventInterceptors(): void {
    // NOTE: TypedEventBus processes listeners in registration order
    // These are registered FIRST (in MainLayout constructor) before GlobalSearchView

    // Intercept global search (Cmd+K → search query) with high priority
    this.eventBus.on('globalSearch:start', (data: { query: string }) => {
      if (!this.layoutService.isSecondaryVisible()) {
        // Wide/Mobile mode: Render search in primary content
        this.renderSearchInPrimaryContent('global', data.query);
      }
      // Default/Right-pane mode: Let GlobalSearchView handle it (via its own listener)
    });

    // Intercept hashtag search (click on hashtag)
    this.eventBus.on('hashtagSearch:start', (data: { hashtag: string }) => {
      if (!this.layoutService.isSecondaryVisible()) {
        // Wide/Mobile mode: Render search in primary content
        this.renderSearchInPrimaryContent('hashtag', data.hashtag);
      }
      // Default/Right-pane mode: Let GlobalSearchView handle it (via its own listener)
    });

    // Intercept profile search (profile search component)
    this.eventBus.on('profileSearch:complete', (data: { query: string; results: any[]; meta: string }) => {
      if (!this.layoutService.isSecondaryVisible()) {
        // Wide/Mobile mode: Render search in primary content
        this.renderSearchInPrimaryContent('profile', data.query);
      }
      // Default/Right-pane mode: Let GlobalSearchView handle it (via its own listener)
    });
  }

  /**
   * Render search results in primary content (wide mode only)
   */
  private renderSearchInPrimaryContent(searchType: 'global' | 'hashtag' | 'profile', query: string): void {
    const primaryContent = this.element.querySelector('.primary-content');
    if (!primaryContent) return;

    // Clear primary content
    primaryContent.innerHTML = '';

    // Create container for search
    const searchContainer = document.createElement('div');
    searchContainer.className = 'search-view-primary';

    // Add header with title and back button
    const header = document.createElement('div');
    header.className = 'search-view-primary__header';

    const title = searchType === 'hashtag'
      ? `#${query}`
      : searchType === 'profile'
      ? `Profile: ${query}`
      : `Search: ${query}`;

    // Create back button with direct event handler
    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'btn-icon search-view-primary__back';
    backBtn.title = 'Back to timeline';
    backBtn.innerHTML = `
      <svg width="24" height="24"><use href="#icon-back"/></svg>
    `;
    backBtn.addEventListener('click', () => {
      Router.getInstance().navigate('/');
    });

    const titleEl = document.createElement('h1');
    titleEl.className = 'search-view-primary__title';
    titleEl.textContent = title;

    header.appendChild(backBtn);
    header.appendChild(titleEl);

    // Add content container
    const content = document.createElement('div');
    content.className = 'search-view-primary__content';

    searchContainer.appendChild(header);
    searchContainer.appendChild(content);
    primaryContent.appendChild(searchContainer);

    // Mount GlobalSearchView content in pcc
    if (this.globalSearchView) {
      const searchElement = this.globalSearchView.getElement();
      content.appendChild(searchElement);

      // Ensure search content is visible (remove tab-content class behavior)
      searchElement.classList.add('tab-content--active');
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
    const homeLink = this.element.querySelector('.primary-nav .primary-nav__link--timeline');
    homeLink?.classList.add('is-active');
  }

  /**
   * Update active navigation based on view class (e.g., 'tv', 'pv', 'nv')
   */
  private updateActiveNavigation(viewClass: string): void {
    // Clear all active states (main nav + list sublinks + addon sublinks)
    const navLinks = this.element.querySelectorAll('.primary-nav > li > a');
    navLinks.forEach(link => link.classList.remove('is-active'));
    this.setActiveListSublink(null);
    this.setActiveAddonSublink(null);

    // Map viewClass abbreviations to nav selectors
    const viewToSelector: Record<string, string> = {
      'tv': '.primary-nav__link--timeline',           // Timeline View
      'pv': '.primary-nav__link--profile',        // Profile View
      'nv': '.primary-nav__link--notifications',  // Notifications View
      'atv': '.primary-nav__link--articles',      // Articles Timeline View
      'av': '.primary-nav__link--articles',       // Article View (single)
      'aev': '.primary-nav__link--articles',      // Article Editor View
      'mv': '.primary-nav__link--messages',       // Messages View
      'cv': '.primary-nav__link--messages',       // Conversation View
      'sv': '.primary-nav__link--settings',        // Settings View
      'adv': '.primary-nav__link--addons'           // Addons View
    };

    const selector = viewToSelector[viewClass];
    if (selector) {
      const activeLink = this.element.querySelector(`.primary-nav ${selector}`);
      activeLink?.classList.add('is-active');
    }

    // For AddonsView: highlight the specific addon sublink
    if (viewClass === 'adv') {
      const path = window.location.pathname;
      const match = path.match(/^\/addons\/(.+)$/);
      if (match) {
        this.setActiveAddonSublink(match[1]!);
      }
    }
  }

  /**
   * Set active state on a list sublink
   */
  private setActiveListSublink(listType: ListType | null): void {
    // Clear all list sublinks
    const listSublinks = this.element.querySelectorAll('.primary-nav__sublink[data-list-type]');
    listSublinks.forEach(link => link.classList.remove('is-active'));

    if (listType) {
      const activeSublink = this.element.querySelector(`.primary-nav__sublink[data-list-type="${listType}"]`);
      activeSublink?.classList.add('is-active');
    }
  }

  private setActiveAddonSublink(addonId: string | null): void {
    const addonSublinks = this.element.querySelectorAll('.primary-nav__sublink[data-addon-type]');
    addonSublinks.forEach(link => link.classList.remove('is-active'));

    if (addonId) {
      const activeSublink = this.element.querySelector(`.primary-nav__sublink[data-addon-type="${addonId}"]`);
      activeSublink?.classList.add('is-active');
    }
  }

  /**
   * Open search modal
   */
  private async openSearchModal(): Promise<void> {
    if (!this.searchSpotlight) {
      const { SearchSpotlight } = await import('../navigation/SearchSpotlight');
      this.searchSpotlight = new SearchSpotlight();
    }
    this.searchSpotlight.open();
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
        // Re-initialize addons now that auth is available
        // (initial init in constructor may have run before auth completed)
        // wallet-balance is handled by AddonLoader via the user:login TypedEventBus event.
        this.initializeAddonsAfterAuth();
        // Update sidebar for logged-in state
        this.element.querySelector('.sidebar')?.classList.remove('sidebar--logged-out');
      } else {
        // User logged out - clear user status
        this.clearUserStatus();
        // Update sidebar for logged-out state
        this.element.querySelector('.sidebar')?.classList.add('sidebar--logged-out');
      }
    });

    // Set initial sidebar state based on current auth status
    if (!this.authStateManager.isLoggedIn()) {
      this.element.querySelector('.sidebar')?.classList.add('sidebar--logged-out');
    }

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
      const profileLink = this.element.querySelector('.sidebar .primary-nav__link--profile') as HTMLAnchorElement;
      if (profileLink) {
        profileLink.href = `/profile/${data.npub}`;
      }

      // The addon submenu is built once at construction; re-apply THIS account's saved order on
      // switch, otherwise the list keeps whatever order the previous account left it in.
      this.applyAddonOrder(data.pubkey);
    });
  }

  /** Reorder the existing addon submenu nodes to match the saved order for `pubkey` (no rebuild). */
  private applyAddonOrder(pubkey: string): void {
    const submenu = this.element.querySelector('.primary-nav__link--addons .primary-nav__submenu') as HTMLElement | null;
    if (!submenu) return;
    const byId = new Map<string, HTMLElement>();
    submenu.querySelectorAll<HTMLElement>(':scope > li[data-addon-id]').forEach(li => byId.set(li.dataset.addonId || '', li));
    // Re-append each row in saved order; appendChild moves the existing node, preserving its
    // wired listeners (wireAddonReorder delegates on the submenu, so it survives the moves).
    for (const entry of getOrderedAddonsForPubkey(pubkey)) {
      const li = byId.get(entry.id);
      if (li) submenu.appendChild(li);
    }
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

      // Exclude sidebar links - they have their own handlers
      if (link.closest('.sidebar')) return;

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
  /** Collapse/expand the left nav sidebar to an icon-only rail; persisted per account. */
  private setupSidebarCollapse(): void {
    const toggle = this.element.querySelector('.sidebar-collapse-toggle') as HTMLElement | null;
    if (!toggle) return;

    const collapsed = PerAccountLocalStorage.getInstance().get<boolean>(StorageKeys.SIDEBAR_COLLAPSED, false);
    this.applySidebarCollapse(collapsed);

    toggle.addEventListener('click', () => {
      const next = !document.documentElement.classList.contains('sidebar-collapsed');
      this.applySidebarCollapse(next);
      PerAccountLocalStorage.getInstance().set(StorageKeys.SIDEBAR_COLLAPSED, next);
    });
  }

  private applySidebarCollapse(collapsed: boolean): void {
    document.documentElement.classList.toggle('sidebar-collapsed', collapsed);

    const toggle = this.element.querySelector('.sidebar-collapse-toggle') as HTMLElement | null;
    const use = toggle?.querySelector('use');
    if (use) use.setAttribute('href', collapsed ? '#icon-chevron-right' : '#icon-chevron-left');
    if (toggle) {
      toggle.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
      toggle.setAttribute('aria-label', toggle.title);
    }

    // Collapsed: surface each item's label as a hover tooltip (labels are hidden by CSS).
    const sidebar = this.element.querySelector('.sidebar');
    if (!sidebar) return;
    sidebar.querySelectorAll<HTMLElement>('.primary-nav__link').forEach(link => {
      const desc = link.querySelector('.primary-nav__item-desc')?.textContent?.trim() || '';
      if (collapsed && desc) {
        if (link.dataset.origTitle === undefined) link.dataset.origTitle = link.getAttribute('title') || '';
        link.title = desc;
      } else if (link.dataset.origTitle !== undefined) {
        if (link.dataset.origTitle) link.title = link.dataset.origTitle; else link.removeAttribute('title');
        delete link.dataset.origTitle;
      }
    });
    sidebar.querySelectorAll<HTMLElement>('.primary-nav__accordion-trigger').forEach(trg => {
      const label = trg.textContent?.trim() || '';
      if (collapsed && label) trg.title = label; else trg.removeAttribute('title');
    });
  }

  private setupNavigationLinks(): void {
    const homeLink = this.element.querySelector('.sidebar .primary-nav__link--timeline');
    if (homeLink) {
      homeLink.addEventListener('click', (e) => {
        e.preventDefault();
        this.handleHomeClick();
      });
    }

    // Each scroll-to-top button only scrolls its view to the top — it must not
    // trigger its parent nav link's navigation (profiles vary by pubkey).
    this.element.querySelectorAll('.scroll-to-top-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.scrollToTop();
      });
    });

    const notificationsLink = this.element.querySelector('.sidebar .primary-nav__link--notifications') as HTMLElement | null;
    if (notificationsLink) {
      const handleNotifications = (e: MouseEvent) => {
        e.preventDefault();
        const navController = getViewNavigationController();
        navController.openView('notifications', undefined, e);
      };
      notificationsLink.addEventListener('click', handleNotifications);
      notificationsLink.addEventListener('auxclick', handleNotifications as EventListener); // Middle-click
    }

    const messagesLink = this.element.querySelector('.sidebar a[href="/messages"]') as HTMLElement | null;
    if (messagesLink) {
      const handleMessages = (e: MouseEvent) => {
        e.preventDefault();
        const navController = getViewNavigationController();
        navController.openView('messages', undefined, e);
      };
      messagesLink.addEventListener('click', handleMessages);
      messagesLink.addEventListener('auxclick', handleMessages as EventListener); // Middle-click
    }

    const settingsLink = this.element.querySelector('.sidebar a[href="/settings"]');
    if (settingsLink) {
      settingsLink.addEventListener('click', (e) => {
        e.preventDefault();
        const router = Router.getInstance();
        router.navigate('/settings');
      });
    }

    // Mobile-only logout: the secondary column (which holds "Sign out" via the
    // AccountSwitcher) is dropped in phone layout, so surface logout here.
    const logoutBtn = this.element.querySelector('.sidebar [data-action="sidebar-logout"]');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.handleLogout();
      });
    }

    // Logged-out twin: after logout the primary-content already shows the login
    // screen — it just sits behind the open drawer, so "Sign in" only needs to
    // close the drawer to reveal the signer options underneath.
    const loginBtn = this.element.querySelector('.sidebar [data-action="sidebar-login"]');
    if (loginBtn) {
      loginBtn.addEventListener('click', (e) => {
        e.preventDefault();
        this.element.querySelector('.sidebar')?.classList.remove('sidebar--open');
        this.element.querySelector('.sidebar-overlay')?.classList.remove('sidebar-overlay--visible');
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

    // Download link - open in system browser (desktop) or navigate (web)
    const downloadLink = this.element.querySelector('.sidebar .primary-nav__link--download');
    if (downloadLink) {
      downloadLink.addEventListener('click', async (e) => {
        e.preventDefault();
        const url = 'https://noornote.app/download/';
        const _p = PlatformService.getInstance();
        if (_p.isElectron) {
          await window.electronAPI!.openExternal(url);
        } else if (_p.isCapacitor) {
          window.open(url, '_blank', 'noopener,noreferrer');
        } else {
          window.location.href = '/download/';
        }
      });
    }

    // Welcome link - reset has_key flag to show welcome screen
    const welcomeLink = this.element.querySelector('.sidebar a[href="/welcome"]');
    if (welcomeLink) {
      welcomeLink.addEventListener('click', (e) => {
        e.preventDefault();
        localStorage.removeItem('noornote_has_key');
        const router = Router.getInstance();
        router.navigate('/welcome');
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

    const profileLink = this.element.querySelector('.sidebar .primary-nav__link--profile') as HTMLElement | null;
    if (profileLink) {
      const handleProfile = (e: MouseEvent) => {
        e.preventDefault();
        const currentUser = this.authService.getCurrentUser();
        if (currentUser) {
          // Already on own profile -> scroll to top (mirrors the Timeline menu item)
          if (Router.getInstance().getCurrentPath() === `/profile/${currentUser.npub}`) {
            this.scrollToTop();
            return;
          }
          const navController = getViewNavigationController();
          navController.openView('profile', currentUser.npub, e);
        }
      };
      profileLink.addEventListener('click', handleProfile);
      profileLink.addEventListener('auxclick', handleProfile as EventListener); // Middle-click
    }

    const searchLink = this.element.querySelector('.sidebar .primary-nav__link--search');
    if (searchLink) {
      searchLink.addEventListener('click', (e) => {
        e.preventDefault();
        this.openSearchModal();
      });
    }

    // New Post Dropup
    this.setupNewPostDropup();
  }

  /**
   * Setup mobile sidebar hamburger menu and overlay
   */
  private setupMobileSidebar(): void {
    const hamburger = this.element.querySelector('.mobile-header__hamburger');
    const overlay = this.element.querySelector('.sidebar-overlay');
    const sidebar = this.element.querySelector('.sidebar');

    if (!hamburger || !overlay || !sidebar) return;

    // Toggle sidebar on hamburger click
    hamburger.addEventListener('click', () => {
      sidebar.classList.toggle('sidebar--open');
      overlay.classList.toggle('sidebar-overlay--visible');
    });

    // Close sidebar on overlay click
    overlay.addEventListener('click', () => {
      sidebar.classList.remove('sidebar--open');
      overlay.classList.remove('sidebar-overlay--visible');
    });

    // Close sidebar when clicking a nav link (in mobile mode)
    const navLinks = sidebar.querySelectorAll('.primary-nav__link, .primary-nav__link--about');
    navLinks.forEach(link => {
      link.addEventListener('click', () => {
        if (this.layoutService.isPhone()) {
          sidebar.classList.remove('sidebar--open');
          overlay.classList.remove('sidebar-overlay--visible');
        }
      });
    });

    // Swipe gestures: edge-swipe to open, swipe-left to close
    const edgeThreshold = 30;
    const minSwipeDistance = 50;
    let startX = 0;
    let startY = 0;

    document.addEventListener('touchstart', (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      startX = touch.clientX;
      startY = touch.clientY;
    }, { passive: true });

    document.addEventListener('touchend', (e: TouchEvent) => {
      if (!this.layoutService.isPhone()) return;
      const touch = e.changedTouches[0];
      if (!touch) return;

      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;

      if (Math.abs(deltaX) <= Math.abs(deltaY) || Math.abs(deltaX) < minSwipeDistance) return;

      const isOpen = sidebar.classList.contains('sidebar--open');

      if (!isOpen && deltaX > 0 && startX < edgeThreshold) {
        // Swipe right from left edge → open
        sidebar.classList.add('sidebar--open');
        overlay.classList.add('sidebar-overlay--visible');
      } else if (isOpen && deltaX < 0) {
        // Swipe left while open → close
        sidebar.classList.remove('sidebar--open');
        overlay.classList.remove('sidebar-overlay--visible');
      }
    }, { passive: true });
  }

  /**
   * Setup pull-to-refresh on primary-content (mobile only)
   */
  private setupPullToRefresh(): void {
    if (!PlatformService.getInstance().isAndroid) return;

    const primaryContent = this.element.querySelector('.primary-content') as HTMLElement;
    if (!primaryContent) return;

    this.pullToRefresh = new PullToRefresh(primaryContent, () => {
      const appState = AppState.getInstance();
      const currentView = appState.getState('view').currentView;

      if (currentView === 'timeline' || currentView === 'profile') {
        TypedEventBus.getInstance().emit('timeline:pull-refresh');
      } else {
        const router = Router.getInstance();
        router.navigate(router.getCurrentPath(), true);
      }
    });
  }

  /**
   * Handle home link click - scroll to top if in timeline, otherwise navigate
   */
  private handleHomeClick(): void {
    const router = Router.getInstance();
    const currentPath = router.getCurrentPath();
    const hasListInPcc = !!this.element.querySelector('.list-view-primary');

    if (hasListInPcc) {
      // List view is rendered in PCC - force navigate to replace it
      router.navigate('/', true);
    } else if (currentPath === '/' || currentPath === '/timeline') {
      // Already in timeline - scroll to top
      this.scrollToTop();
    } else {
      // Navigate to timeline
      router.navigate('/');
    }
  }

  /**
   * Scroll timeline to top
   * Handles both TimelineView (with tabs) and fallback to primary-content
   */
  private scrollToTop(): void {
    // TimelineView has its own scrollable container
    const timelineViewScroll = this.element.querySelector('.timeline-view__timeline');
    if (timelineViewScroll) {
      timelineViewScroll.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    // Fallback to primary-content for other views
    const primaryContent = this.element.querySelector('.primary-content');
    if (primaryContent) {
      primaryContent.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  /**
   * Setup scroll listener for scroll-to-top button visibility
   * Handles both TimelineView (with tabs) and fallback to primary-content
   */
  private setupScrollListener(): void {
    // Wait for element to be mounted
    setTimeout(() => {
      const scrollButtons = this.element.querySelectorAll('.scroll-to-top-btn');
      if (scrollButtons.length === 0) return;

      // Each scroll-to-top button is scoped to a view via data-scroll-view.
      // Show the one matching the current view once scrolled down (> 100px).
      const handleScroll = (scrollContainer: Element) => {
        const currentView = this.appState.getState('view').currentView;
        const scrolled = scrollContainer.scrollTop > 100;
        scrollButtons.forEach((btn) => {
          const forView = (btn as HTMLElement).dataset.scrollView;
          (btn as HTMLElement).style.display = forView === currentView && scrolled ? 'inline-block' : 'none';
        });
      };

      // Listen to primary-content scroll (covers most cases)
      const primaryContent = this.element.querySelector('.primary-content');
      if (primaryContent) {
        primaryContent.addEventListener('scroll', () => handleScroll(primaryContent));
      }

      // Use MutationObserver to attach listener when TimelineView is rendered
      const observer = new MutationObserver(() => {
        const timelineViewScroll = this.element.querySelector('.timeline-view__timeline');
        if (timelineViewScroll && !(timelineViewScroll as HTMLElement).dataset.scrollListenerAttached) {
          (timelineViewScroll as HTMLElement).dataset.scrollListenerAttached = 'true';
          timelineViewScroll.addEventListener('scroll', () => handleScroll(timelineViewScroll));
        }
      });

      if (primaryContent) {
        observer.observe(primaryContent, { childList: true, subtree: true });
      }
    }, 100);
  }

  /**
   * Setup tab switching in aside.secondary-content
   * Note: List tabs (Bookmarks/Follows/Mutes) are handled dynamically via openListTab()
   */
  private setupTabSwitching(): void {
    const dropdownMount = this.element.querySelector('[data-role="scc-dropdown-mount"]');
    if (!dropdownMount) return;

    const savedDefault = getSccDefaultTab();

    this.sccDefaultDropdown = new CustomDropdown({
      options: [
        { value: 'system-log', label: 'System Logs' },
        { value: 'newest-articles', label: 'Newest Articles' },
        { value: 'media', label: 'Media' }
      ],
      selectedValue: savedDefault,
      onChange: (value) => {
        const sccValue = value as SccDefaultContent;
        setSccDefaultTab(sccValue);
        this.activateSccDefault(sccValue);
      },
      className: 'scc-default-dropdown'
    });

    dropdownMount.appendChild(this.sccDefaultDropdown.getElement());
    this.activateSccDefault(savedDefault);

    this.eventBus.on('settings:scc-excerpt-limit-changed', () => {
      if (!this.sccArticleFeed) return;
      const contentDiv = this.element.querySelector('[data-tab-content="newest-articles"]') as HTMLElement | null;
      if (!contentDiv) return;
      this.sccArticleFeed.destroy();
      this.sccArticleFeed = new SccArticleFeed(contentDiv);
    });
  }

  private activateSccDefault(value: SccDefaultContent): void {
    const secondaryContent = this.element.querySelector('.secondary-content') as HTMLElement;
    if (!secondaryContent) return;

    if (value === 'newest-articles' && !this.sccArticleFeed) {
      const contentDiv = secondaryContent.querySelector('[data-tab-content="newest-articles"]');
      if (contentDiv) {
        this.sccArticleFeed = new SccArticleFeed(contentDiv as HTMLElement);
      }
    }

    if (value === 'media' && !this.sccMediaFeed) {
      const contentDiv = secondaryContent.querySelector('[data-tab-content="media"]');
      if (contentDiv) {
        this.sccMediaFeed = new SccMediaFeed(contentDiv as HTMLElement);
      }
    }

    deactivateAllTabs(secondaryContent);
    switchTabWithContent(secondaryContent, value);
    this.viewTabManager?.deactivateCurrentViewTab();

    // The log panel skips rendering while hidden; render its current logs now that
    // it is the visible tab again.
    if (value === 'system-log') this.systemLogger.refresh();

    this.syncScc();
  }


  /**
   * Create the main layout structure
   */
  private createElement(): HTMLElement {
    const layout = document.createElement('div');
    layout.className = 'main-layout';
    layout.innerHTML = `
      <header class="mobile-header">
        <button class="mobile-header__hamburger" aria-label="Open menu">
          <svg width="24" height="24"><use href="#icon-menu-bars"/></svg>
          <span class="hamburger-badge"></span>
        </button>
        <span class="nn-logo">NoorNote</span>
      </header>
      <div class="sidebar-overlay"></div>
      <aside class="sidebar" aria-label="Navigation">
        <div class="sidebar-content">
          <div class="sidebar-scrollable">
            <div class="sidebar-header">
              <span class="nn-logo">NoorNote</span>
              <button class="sidebar-collapse-toggle" type="button" aria-label="Collapse sidebar" title="Collapse sidebar">
                <svg class="sidebar-collapse-toggle__icon"><use href="#icon-chevron-left"/></svg>
              </button>
            </div>
            <div class="sidebar-welcome-link">
              <a href="/welcome" class="primary-nav__link primary-nav__link--welcome">
                <svg class="primary-nav__item-icon"><use href="#icon-home"/></svg>
                <span class="primary-nav__item-desc">Welcome</span>
              </a>
            </div>
            <div class="wallet-balance-container">
              <!-- WalletBalanceDisplay will be mounted here -->
            </div>
            <ul class="primary-nav">
            <li>
              <a href="/" class="primary-nav__link primary-nav__link--timeline" title="Scroll to top">
                <svg class="primary-nav__item-icon"><use href="#icon-home"/></svg>
                <span class="primary-nav__item-desc">Timeline</span>
                <svg class="scroll-to-top-btn" data-scroll-view="timeline" style="display: none;" role="button" aria-label="Scroll to top" tabindex="0"><use href="#icon-scroll-to-top"/></svg>
              </a>
            </li>
            <li>
              <a href="/profile" class="primary-nav__link primary-nav__link--timeline primary-nav__link--profile" title="Scroll to top">
                <svg class="primary-nav__item-icon"><use href="#icon-profile"/></svg>
                <span class="primary-nav__item-desc">Profile</span>
                <svg class="scroll-to-top-btn" data-scroll-view="profile" style="display: none;" role="button" aria-label="Scroll to top" tabindex="0"><use href="#icon-scroll-to-top"/></svg>
              </a>
            </li>
            <li>
              <a href="/notifications" class="primary-nav__link primary-nav__link--notifications">
                <svg class="primary-nav__item-icon"><use href="#icon-notifications"/></svg>
                <span class="primary-nav__item-desc">Notifications</span>
                <span class="notifications-badge"></span>
              </a>
            </li>
            <li>
              <a href="/articles" class="primary-nav__link primary-nav__link--articles">
                <svg class="primary-nav__item-icon"><use href="#icon-articles"/></svg>
                <span class="primary-nav__item-desc">Articles</span>
              </a>
            </li>
            <li>
              <a href="/messages" class="primary-nav__link primary-nav__link--messages">
                <svg class="primary-nav__item-icon"><use href="#icon-email"/></svg>
                <span class="primary-nav__item-desc">Messages</span>
                <span class="badge badge--green dm-badge" style="display: none"></span>
              </a>
            </li>
            <li>
              <a href="/settings" class="primary-nav__link primary-nav__link--settings">
                <svg class="primary-nav__item-icon"><use href="#icon-settings"/></svg>
                <span class="primary-nav__item-desc">Settings</span>
              </a>
            </li>
            <li>
              <a href="#" class="primary-nav__link primary-nav__link--search">
                <svg class="primary-nav__item-icon"><use href="#icon-search"/></svg>
                <span class="primary-nav__item-desc">Search</span>
              </a>
            </li>
            <li>
              <a href="/download/" class="primary-nav__link primary-nav__link--download">
                <svg class="primary-nav__item-icon"><use href="#icon-download"/></svg>
                <span class="primary-nav__item-desc">Download</span>
              </a>
            </li>
          </ul>
            <div class="nm-sidebar-widget-container"></div>
            <div class="data-saver-toggle"></div>
            <div class="l-row--right sidebar-logout">
              <button type="button" class="btn btn--passive btn--mini sidebar-logout__signout" data-action="sidebar-logout">
                <svg class="primary-nav__item-icon"><use href="#icon-logout"/></svg>
                Sign out
              </button>
              <button type="button" class="btn btn--passive btn--mini sidebar-logout__signin" data-action="sidebar-login">
                <svg class="primary-nav__item-icon sidebar-logout__signin-icon"><use href="#icon-logout"/></svg>
                Sign in
              </button>
            </div>
            <div class="current-datetime-display">--</div>
          </div>
          <div class="new-post-dropup">
            <button class="btn btn--new-post">
              <svg width="24" height="24"><use href="#icon-plus"/></svg>
              New Post
              <span class="dropup-arrow" aria-hidden="true"></span>
            </button>
            <div class="new-post-dropup__menu">
              <button class="new-post-dropup__item" data-action="new-note">
                <svg width="24" height="24"><use href="#icon-edit"/></svg>
                Note
              </button>
              <button class="new-post-dropup__item" data-action="new-article">
                <svg width="24" height="24"><use href="#icon-articles-full"/></svg>
                Article
              </button>
              <button class="new-post-dropup__item" data-action="new-video">
                <svg width="24" height="24"><use href="#icon-video"/></svg>
                Video
              </button>
              <button class="new-post-dropup__item new-post-dropup__item--product" data-action="new-product" style="display: none;">
                <svg width="24" height="24"><use href="#icon-shopping-bag"/></svg>
                Product
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

      <main class="primary-content" tabindex="0">
        <!-- Content will be dynamically updated based on auth state -->
      </main>

      <aside class="secondary-content" aria-label="Details">
        <div class="user-login-bar">
          <!-- User status will be mounted here -->
        </div>
        <div id="sidebar-tabs" class="tabs">
          <div data-role="scc-dropdown-mount"></div>
          <!-- List tabs (Bookmarks/Follows/Mutes) will be inserted dynamically here -->
        </div>
        <div class="secondary-content-body">
          <div class="tab-content tab-content--active" data-tab-content="system-log">
            <!-- Debug Logger will be mounted here -->
          </div>
          <div class="tab-content" data-tab-content="newest-articles">
          </div>
          <div class="tab-content" data-tab-content="media">
            <!-- Article feed will be mounted here -->
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
    // Clean up existing
    if (this.userStatus) this.userStatus.destroy();
    if (this.fontSizeSwitcher) this.fontSizeSwitcher.destroy();
    if (this.themeSwitcher) this.themeSwitcher.destroy();

    // Create theme switcher + font size switcher + account switcher
    this.themeSwitcher = new ThemeSwitcher();
    this.fontSizeSwitcher = new FontSizeSwitcher();
    this.userStatus = new AccountSwitcher({
      npub,
      pubkey,
      onLogout: () => this.handleLogout(),
      onAddAccount: () => this.handleAddAccount()
    });

    // Mount in secondary content (visible in default/right-pane modes)
    const secondaryUser = this.element.querySelector('.user-login-bar');
    if (secondaryUser) {
      secondaryUser.innerHTML = '';
      secondaryUser.appendChild(this.themeSwitcher.getElement());
      secondaryUser.appendChild(this.fontSizeSwitcher.getElement());
      secondaryUser.appendChild(this.userStatus.getElement());
    }

    // Mount sidebar extras (Data Saver toggle on Android)
    // Data Saver toggle (Android only)
    const dataSaverMount = this.element.querySelector('.data-saver-toggle');
    if (dataSaverMount && PlatformService.getInstance().isAndroid) {
      const sw = new Switch({
        label: 'Data Saver',
        checked: isDataSaverEnabled(),
        onChange: (checked) => {
          setDataSaverEnabled(checked);
          if (!checked) {
            document.querySelectorAll('.media-placeholder').forEach(ph => {
              const el = ph as HTMLElement;
              const src = el.dataset.src;
              const type = el.dataset.type;
              if (!src || !type) return;
              if (type === 'image') {
                const img = document.createElement('img');
                img.src = src;
                img.alt = el.dataset.alt || '';
                img.className = 'note-image note-image--clickable';
                img.loading = 'lazy';
                img.dataset.imageIndex = el.dataset.index || '0';
                el.replaceWith(img);
              } else if (type === 'video') {
                const video = document.createElement('video');
                video.src = src;
                video.controls = true;
                video.className = 'note-video';
                video.preload = 'metadata';
                if (el.dataset.poster) video.poster = el.dataset.poster;
                el.replaceWith(video);
              } else if (type === 'audio') {
                const audio = document.createElement('audio');
                audio.src = src;
                audio.controls = true;
                audio.preload = 'metadata';
                audio.className = 'note-audio';
                el.replaceWith(audio);
              }
            });
          }
        }
      });
      dataSaverMount.innerHTML = sw.render();
      sw.setupEventListeners(dataSaverMount as HTMLElement);
    }

    // Update profile link href (event listener is set up in setupNavigationLinks)
    const profileLink = this.element.querySelector('.sidebar .primary-nav__link--profile') as HTMLAnchorElement;
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
    const authMethod = this.authService.getAuthMethod();

    if (authMethod === 'key-signer') {
      const isSilentMode = localStorage.getItem('noorsigner_silent_mode') !== 'false';
      if (isSilentMode) {
        this.showAddAccountSilent();
      } else {
        this.showAddAccountInstructions();
      }
    } else {
      // Bunker: Navigate to login
      sessionStorage.setItem('noornote_add_account', 'true');
      const router = Router.getInstance();
      router.navigate('/login');
    }
  }

  /**
   * Show import modal for adding account in silent mode
   */
  private async showAddAccountSilent(): Promise<void> {
    const { ImportToNoorSignerModal } = await import('../modals/ImportToNoorSignerModal');
    const modal = new ImportToNoorSignerModal({
      nsec: '',
      npub: '',
      showNsecInput: true,
      onSuccess: async () => {
        // Re-authenticate with newly added account
        const result = await this.authService.authenticateWithKeySigner();
        if (result.success) {
          window.location.reload();
        }
      }
    });
    modal.show();
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
      await window.electronAPI!.cancelKeySignerLaunch();
      await window.electronAPI!.launchKeySigner('add-account');
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

    const secondaryUser = this.element.querySelector('.user-login-bar');
    if (secondaryUser) {
      secondaryUser.innerHTML = '';
      // Re-mount AuthComponent to show Login button again
      if (this.authComponent) {
        secondaryUser.appendChild(this.authComponent.getElement());
      }
    }

    // Reset profile link on logout (event listener remains in setupNavigationLinks)
    const profileLink = this.element.querySelector('.sidebar .primary-nav__link--profile') as HTMLAnchorElement;
    if (profileLink) {
      profileLink.href = '/profile';
    }
  }

  /**
   * Initialize content areas
   */
  private initializeContent(): void {
    // Mount auth component in user-login-bar (top right - Login/Logout)
    this.authComponent = new AuthComponent(this);
    const secondaryUser = this.element.querySelector('.user-login-bar');
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
   * Setup New Post dropup menu
   */
  private setupNewPostDropup(): void {
    const dropup = this.element.querySelector('.new-post-dropup');
    const button = dropup?.querySelector('.btn--new-post');
    const menu = dropup?.querySelector('.new-post-dropup__menu');

    if (!dropup || !button || !menu) return;

    const menuEl = menu as HTMLElement;
    const buttonEl = button as HTMLElement;

    // When the sidebar is collapsed to an icon rail (64px), there is no room for
    // the menu inside the column and the rail clips horizontal overflow. In that
    // case detach the menu into a fixed-position layer anchored to the button so
    // it floats over the timeline instead of being squeezed and clipped.
    const isRailCollapsed = () =>
      document.documentElement.classList.contains('sidebar-collapsed') &&
      !document.documentElement.classList.contains('layout--phone');

    const openMenu = () => {
      const floating = isRailCollapsed();
      menuEl.classList.toggle('new-post-dropup__menu--floating', floating);
      if (floating) {
        const rect = buttonEl.getBoundingClientRect();
        menuEl.style.left = `${rect.left}px`;
        menuEl.style.bottom = `${window.innerHeight - rect.top + 8}px`;
      }
      menuEl.classList.add('is-open');
    };

    const closeMenu = () => {
      menuEl.classList.remove('is-open', 'new-post-dropup__menu--floating');
      menuEl.style.left = '';
      menuEl.style.bottom = '';
    };

    // Toggle menu on button click
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menuEl.classList.contains('is-open')) closeMenu();
      else openMenu();
    });

    // A resize can invalidate the floating anchor; close to avoid a stale layer.
    window.addEventListener('resize', () => {
      if (menuEl.classList.contains('is-open')) closeMenu();
    });

    // Handle menu item clicks
    const noteItem = menu.querySelector('[data-action="new-note"]');
    const articleItem = menu.querySelector('[data-action="new-article"]');

    noteItem?.addEventListener('click', async () => {
      closeMenu();
      const { PostNoteModal } = await import('../post/PostNoteModal');
      PostNoteModal.getInstance().show();
    });

    articleItem?.addEventListener('click', () => {
      closeMenu();
      Router.getInstance().navigate('/write-article');
    });

    const videoItem = menu.querySelector('[data-action="new-video"]');
    videoItem?.addEventListener('click', () => {
      closeMenu();
      Router.getInstance().navigate('/write-video');
    });

    // Product item (only visible when marketplace is enabled)
    const productItem = menu.querySelector('[data-action="new-product"]');
    productItem?.addEventListener('click', () => {
      closeMenu();
      Router.getInstance().navigate('/write-listing');
    });

    // Show/hide product item based on marketplace state
    const updateProductVisibility = async () => {
      const { isMarketplaceEnabled } = await import('../../addons/marketplace/index');
      if (productItem) {
        (productItem as HTMLElement).style.display = isMarketplaceEnabled() ? '' : 'none';
      }
    };
    updateProductVisibility();
    this.eventBus.on('marketplace:toggle', () => updateProductVisibility());
    this.eventBus.on('user:login', () => updateProductVisibility());

    // Close menu when clicking outside
    document.addEventListener('click', (e) => {
      if (!dropup.contains(e.target as Node)) {
        closeMenu();
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
   * Initialize dayjs calendar system for date/time display
   */
  private async initializeDateTimeCalendar(): Promise<void> {
    const [dayjsModule, calendarSystemsModule, hijriModule] = await Promise.all([
      import('dayjs'),
      import('@calidy/dayjs-calendarsystems'),
      import('@calidy/dayjs-calendarsystems/calendarSystems/HijriCalendarSystem')
    ]);
    this._dayjs = dayjsModule.default;
    this._dayjs.extend(calendarSystemsModule.default);
    this._dayjs.registerCalendarSystem('hijri' as any, new hijriModule.default());

    // Listen for calendar system changes
    this.eventBus.on('settings:calendar-system-changed', () => {
      this.updateCurrentDateTime();
    });
  }

  /**
   * Start periodic date/time updates
   */
  private startDateTimeUpdates(): void {
    this.updateCurrentDateTime(); // Initial update
    this.dateTimeUpdateInterval = window.setInterval(() => {
      this.updateCurrentDateTime();
    }, 10000); // Update every 10 seconds
  }

  /**
   * Update current date/time display in sidebar
   */
  private updateCurrentDateTime(): void {
    const dateTimeDisplay = this.element.querySelector('.current-datetime-display');
    if (!dateTimeDisplay) return;

    const now = new Date();
    const storage = PerAccountLocalStorage.getInstance();
    const calendarSystem = storage.get<string>(StorageKeys.CALENDAR_SYSTEM, 'gregorian');
    const version = `v${__APP_VERSION__}`;
    const aboutLink = '<a href="/about" class="primary-nav__link--about">About</a>';

    // Format date based on calendar system
    let dateString = '';

    if (calendarSystem === 'gregorian') {
      const day = now.getDate();
      const month = now.toLocaleString('en-US', { month: 'short' });
      const year = now.getFullYear();
      dateString = `<span>${day}. ${month}. ${year}</span><span>${version}</span>${aboutLink}`;
    } else if (calendarSystem === 'hijri') {
      if (!this._dayjs) return; // dayjs not loaded yet (async init)
      const hijriDate = this._dayjs(now).toCalendarSystem('hijri' as any);
      const day = hijriDate.date();
      const month = HIJRI_MONTHS[hijriDate.month()];
      const year = hijriDate.year();
      dateString = `<span>${day}. ${month} ${year}</span><span>${version}</span>${aboutLink}`;
    } else if (calendarSystem === 'both') {
      if (!this._dayjs) return; // dayjs not loaded yet (async init)
      const gregorianDay = now.getDate();
      const gregorianMonth = now.toLocaleString('en-US', { month: 'short' });
      const gregorianYear = now.getFullYear();

      const hijriDate = this._dayjs(now).toCalendarSystem('hijri' as any);
      const hijriDay = hijriDate.date();
      const hijriMonth = HIJRI_MONTHS[hijriDate.month()];
      const hijriYear = hijriDate.year();
      dateString = `<span>${gregorianDay}. ${gregorianMonth}. ${gregorianYear}</span><span>${hijriDay}. ${hijriMonth} ${hijriYear}</span><span>${version}</span>${aboutLink}`;
    }

    dateTimeDisplay.innerHTML = dateString;
  }

  /**
   * Stop date/time updates
   */
  private stopDateTimeUpdates(): void {
    if (this.dateTimeUpdateInterval !== null) {
      clearInterval(this.dateTimeUpdateInterval);
      this.dateTimeUpdateInterval = null;
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
   * Show welcome screen (new users - "Are you new to Nostr?")
   */
  public showWelcomeScreen(): void {
    if (!this.onboardingComponent) {
      this.onboardingComponent = new OnboardingComponent();
    }
    this.onboardingComponent.showWelcomeScreen();
  }

  /**
   * Cleanup welcome page resources (SCC onboarding tab, public timeline)
   * Called by ViewMountingService when navigating away from /welcome
   */
  public cleanupWelcome(): void {
    if (this.onboardingComponent) {
      this.onboardingComponent.restoreSCC();
      this.onboardingComponent.destroyTimeline();
    }
  }

  /**
   * Show create account screen (keypair generation)
   */
  public showCreateAccountScreen(): void {
    if (!this.onboardingComponent) {
      this.onboardingComponent = new OnboardingComponent();
    }
    this.onboardingComponent.showCreateAccountScreen();
  }

  /**
   * Show profile setup wizard (new account onboarding).
   * Wizard renders fullscreen, hiding the main app layout.
   */
  public async showAccountSetupWizard(): Promise<void> {
    const { AccountSetupWizard } = await import('../onboarding/AccountSetupWizard');
    const wizard = new AccountSetupWizard();
    wizard.show();
  }

  /**
   * Addons: Insert sidebar entry (always visible, not gated by any single addon).
   * Inserts before Download link, after Lists accordion.
   */
  private addonsAccordionOpen = false;

  private insertAddonsSidebarEntry(navContainer: Element | null): void {
    if (!navContainer) return;
    if (navContainer.querySelector('.primary-nav__link--addons')) return;

    // Source of truth: src/addons/registry.ts, reordered by the user's saved preference.
    const addonItems = getOrderedAddons().map(a => ({ id: a.id, name: a.name }));

    const li = document.createElement('li');
    li.className = 'primary-nav__item primary-nav__item--accordion primary-nav__link--addons';
    li.innerHTML = `
      <button class="primary-nav__accordion-trigger">
        <svg class="primary-nav__item-icon"><use href="#icon-addons"/></svg>
        Addons
      </button>
      <ul class="primary-nav__submenu">
        ${addonItems.map(a => `
          <li data-addon-id="${a.id}">
            <a href="#" class="primary-nav__sublink" data-addon-type="${a.id}" draggable="false">
              <svg class="primary-nav__sublink-icon"><use href="#icon-addons"/></svg>
              <span class="primary-nav__sublink-desc">${a.name}</span>
            </a>
            <span class="addon-reorder">
              <button class="addon-reorder__btn" data-reorder="up" aria-label="Move up"><svg><use href="#icon-chevron-up"/></svg></button>
              <button class="addon-reorder__btn" data-reorder="down" aria-label="Move down"><svg><use href="#icon-chevron-down"/></svg></button>
            </span>
          </li>
        `).join('')}
      </ul>
    `;

    // Collapsed icon rail: the submenu opens as a floating panel next to the icon.
    const addonsSubmenu = li.querySelector('.primary-nav__submenu') as HTMLElement | null;
    const trigger = li.querySelector('.primary-nav__accordion-trigger') as HTMLElement | null;
    const flyout = trigger && addonsSubmenu ? new RailFlyout(trigger, addonsSubmenu) : null;

    // Accordion trigger
    trigger?.addEventListener('click', (e) => {
      e.preventDefault();
      if (flyout?.handleTriggerClick()) return;
      this.addonsAccordionOpen = !this.addonsAccordionOpen;
      li.classList.toggle('primary-nav__item--expanded', this.addonsAccordionOpen);
    });

    // Sublink handlers
    li.querySelectorAll('.primary-nav__sublink').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        flyout?.close();
        const addonId = (link as HTMLElement).dataset.addonType;
        if (addonId) {
          if (this.layoutService.isPhone()) {
            this.element.querySelector('.sidebar')?.classList.remove('sidebar--open');
            this.element.querySelector('.sidebar-overlay')?.classList.remove('sidebar-overlay--visible');
          }
          this.setActiveAddonSublink(addonId);
          Router.getInstance().navigate(`/addons/${addonId}`);
        }
      });
    });

    // Drag&drop (desktop) + long-press ▲▼ (touch) reordering of the addon list.
    const submenu = li.querySelector('.primary-nav__submenu') as HTMLElement | null;
    if (submenu) wireAddonReorder(submenu);

    const downloadLink = navContainer.querySelector('.primary-nav__link--download')?.parentElement;
    if (downloadLink) {
      navContainer.insertBefore(li, downloadLink);
    } else {
      navContainer.appendChild(li);
    }
  }

  /**
   * Open a list tab (Bookmarks, Follows, or Muted Users)
   * Replaces any existing list tab
   * Renders in pcc (Wide) or scc (Default/Right-pane) based on layout mode
   */
  public openListTab(listType: ListType, customRender?: (container: HTMLElement) => void): void {
    // Close sidebar in phone mode (sublinks are added after setupMobileSidebar)
    if (this.layoutService.isPhone()) {
      this.element.querySelector('.sidebar')?.classList.remove('sidebar--open');
      this.element.querySelector('.sidebar-overlay')?.classList.remove('sidebar-overlay--visible');
    }

    // Check layout mode and delegate to appropriate renderer
    if (!this.layoutService.isSecondaryVisible()) {
      // Wide/Mobile mode: Render in primary content (scc is hidden)
      this.renderListInPrimaryContent(listType, customRender);
    } else {
      // Default or Right-pane mode: Render in secondary content
      this.renderListInSecondaryContent(listType, customRender);
    }
  }

  /**
   * Open an external user-list tab (read-only): the target's follows, or the
   * users who follow the target. Results stream in progressively.
   */
  public openExternalUserListTab(pubkey: string, mode: 'follows' | 'followers'): void {
    // Import dynamically to avoid circular dependencies
    import('../../lists/follows').then(({ ExternalFollowListManager }) => {
      if (!this.layoutService.isSecondaryVisible()) {
        this.renderExternalFollowsInPrimaryContent(pubkey, mode, ExternalFollowListManager);
      } else {
        this.renderExternalFollowsInSecondaryContent(pubkey, mode, ExternalFollowListManager);
      }
    });
  }

  /**
   * Render external follows in secondary content
   */
  private renderExternalFollowsInSecondaryContent(pubkey: string, mode: 'follows' | 'followers', ExternalFollowListManager: any): void {
    // Close existing list tab if any
    if (this.currentListView) {
      this.currentListView.destroy();
      this.currentListView = null;
    }
    // Tear down any previously-open external manager so its background sweep
    // does not keep streaming into a detached node.
    this.destroyExternalFollowManager();

    // Clear active state on list sublinks
    this.clearActiveListSublinks();

    // Track the open external list so syncScc can mirror it into ?scc=.
    this.externalUserList = { mode, pubkey };

    // Create manager instance and track it for lifecycle management.
    const externalManager = ExternalFollowListManager.create(pubkey, mode);
    this.externalFollowManager = externalManager;

    // Create new list view
    // Distinct tabContentId keeps the external (read-only) list's tab id and
    // content attribute (`list-external-follows`) separate from the editable
    // own-follows list (`list-follows`), so FollowListManager's global
    // `[data-tab-content="list-follows"]` queries (refreshListIfActive, zap
    // badges, unfollow header) can never reach into this external list.
    this.currentListView = new ListViewPartial({
      type: 'follows',
      tabContentId: 'list-external-follows',
      title: mode === 'followers' ? 'Followers' : 'Following',
      onClose: () => this.closeListTab(),
      onRender: (container) => {
        externalManager.renderListTab(container);
      }
    });

    // Insert tab and content into DOM (scc)
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
        if ((e.target as HTMLElement).closest('.tab__close')) {
          return;
        }
        deactivateAllTabs(secondaryContent);
        this.currentListView?.activate();
        this.viewTabManager?.deactivateCurrentViewTab();
        this.syncScc();
      });

      // Activate the new tab
      deactivateAllTabs(secondaryContent);
      this.currentListView.activate();
      this.viewTabManager?.deactivateCurrentViewTab();

      // Render content
      this.currentListView.renderContent();

      // Mirror the freshly opened external list into ?scc=.
      this.syncScc();
    }
  }

  /**
   * Render external follows in primary content (wide mode)
   */
  private renderExternalFollowsInPrimaryContent(pubkey: string, mode: 'follows' | 'followers', ExternalFollowListManager: any): void {
    const primaryContent = this.element.querySelector('.primary-content');
    if (!primaryContent) return;

    primaryContent.innerHTML = '';

    // Primary (wide) mode has no scc tab; ensure no stale ?scc= state lingers.
    this.externalUserList = null;
    // Tear down any previously-open external manager before starting a new one.
    this.destroyExternalFollowManager();

    // Create manager instance and track it for lifecycle management.
    const externalManager = ExternalFollowListManager.create(pubkey, mode);
    this.externalFollowManager = externalManager;

    // Create container for list
    const listContainer = document.createElement('div');
    listContainer.className = 'list-view-primary';

    // Add header with title and back button
    const header = document.createElement('div');
    header.className = 'list-view-primary__header l-spread';

    const title = document.createElement('h2');
    title.className = 'list-view-primary__title';
    title.textContent = mode === 'followers' ? 'Followers' : 'Following';

    const backBtn = document.createElement('button');
    backBtn.className = 'list-view-primary__back btn btn--medium btn--passive';
    backBtn.innerHTML = '← Back';
    backBtn.addEventListener('click', () => {
      history.back();
    });

    header.appendChild(title);
    header.appendChild(backBtn);

    // Create content container
    const contentContainer = document.createElement('div');
    contentContainer.className = 'list-view-primary__content tab-content tab-content--active';

    listContainer.appendChild(header);
    listContainer.appendChild(contentContainer);
    primaryContent.appendChild(listContainer);

    // Render content
    externalManager.renderListTab(contentContainer);
  }

  /**
   * Clear active state on all list sublinks
   */
  private clearActiveListSublinks(): void {
    const sublinks = this.element.querySelectorAll('.lists-menu__sublink');
    sublinks.forEach(link => link.classList.remove('lists-menu__sublink--active'));
  }

  /**
   * Tear down the active ExternalFollowListManager (if any) so its background
   * follower/following relay sweep stops instead of streaming into a detached
   * DOM node. Safe to call when none is active.
   */
  private destroyExternalFollowManager(): void {
    if (this.externalFollowManager) {
      try {
        this.externalFollowManager.destroy();
      } catch {
        // Manager already gone — ignore.
      }
      this.externalFollowManager = null;
    }
  }

  /**
   * Render list in secondary content (default/right-pane mode)
   */
  private renderListInSecondaryContent(listType: ListType, customRender?: (container: HTMLElement) => void): void {
    // Close existing list tab if any
    if (this.currentListView) {
      this.currentListView.destroy();
      this.currentListView = null;
    }

    // Own list, not an external user-list — drop any tracked external state
    // and stop its background sweep.
    this.externalUserList = null;
    this.destroyExternalFollowManager();

    // Set active state on list sublink
    this.setActiveListSublink(listType);

    // Map list types to titles
    const titles: Record<ListType, string> = {
      bookmarks: 'List: Bookmarks',
      follows: 'List: Follows',
      mutes: 'List: Muted',
      tribes: 'List: Tribes',
    };

    // Map list types to managers
    const managers: Record<ListType, any> = {
      bookmarks: this.bookmarkManager,
      follows: this.followManager,
      mutes: this.muteManager,
      tribes: this.tribeManager,
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
        // Use custom render callback if provided, otherwise delegate to manager
        if (customRender) {
          customRender(container);
        } else {
          manager.renderListTab(container);
        }
      }
    });

    // Insert tab and content into DOM (scc)
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
        // Notify ViewTabManager that a non-view tab was activated
        this.viewTabManager?.deactivateCurrentViewTab();
        this.syncScc();
      });

      // Activate the new tab (scoped to secondary-content only)
      deactivateAllTabs(secondaryContent);
      this.currentListView.activate();
      // Notify ViewTabManager that a non-view tab was activated
      this.viewTabManager?.deactivateCurrentViewTab();
      this.syncScc();

      // Render content
      this.currentListView.renderContent();
    }
  }

  /**
   * Render list in primary content (wide mode only)
   * Replaces timeline/existing content
   */
  private renderListInPrimaryContent(listType: ListType, customRender?: (container: HTMLElement) => void): void {
    const primaryContent = this.element.querySelector('.primary-content');
    if (!primaryContent) return;

    // Update navigation active state
    const navLinks = this.element.querySelectorAll('.primary-nav > li > a');
    navLinks.forEach(link => link.classList.remove('is-active'));
    this.setActiveListSublink(listType);

    // Clear primary content
    primaryContent.innerHTML = '';

    // Map list types to titles
    const titles: Record<ListType, string> = {
      bookmarks: 'List: Bookmarks',
      follows: 'List: Follows',
      mutes: 'List: Muted',
      tribes: 'List: Tribes',
    };

    // Map list types to managers
    const managers: Record<ListType, any> = {
      bookmarks: this.bookmarkManager,
      follows: this.followManager,
      mutes: this.muteManager,
      tribes: this.tribeManager,
    };

    const manager = managers[listType];
    if (!manager) {
      console.error(`[MainLayout] No manager found for list type: ${listType}`);
      return;
    }

    // Create container for list
    const listContainer = document.createElement('div');
    listContainer.className = 'list-view-primary';

    // Add header with title and back button
    const header = document.createElement('div');
    header.className = 'list-view-primary__header l-spread';

    const titleEl = document.createElement('h1');
    titleEl.className = 'list-view-primary__title';
    titleEl.textContent = titles[listType];

    // Create back button with direct event handler
    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'btn-icon list-view-primary__back';
    backBtn.title = 'Back to timeline';
    backBtn.innerHTML = `
      <svg width="24" height="24"><use href="#icon-back"/></svg>
    `;
    backBtn.addEventListener('click', () => {
      Router.getInstance().navigate('/');
    });

    header.appendChild(titleEl);
    header.appendChild(backBtn);

    // Add content container with data-tab-content for manager selectors
    const content = document.createElement('div');
    content.className = 'list-view-primary__content';
    content.dataset.tabContent = `list-${listType}`;

    listContainer.appendChild(header);
    listContainer.appendChild(content);
    primaryContent.appendChild(listContainer);

    // Render list content via manager or custom callback
    if (customRender) {
      customRender(content);
    } else {
      manager.renderListTab(content);
    }
  }

  /**
   * Close the current list tab
   * Only used for right-pane mode (scc)
   * For default/wide mode, back button navigates to '/'
   */
  public closeListTab(): void {
    if (this.currentListView) {
      this.currentListView.destroy();
      this.currentListView = null;
      this.externalUserList = null;

      // Stop the external follower/following background sweep.
      this.destroyExternalFollowManager();

      // Clear active state on list sublinks
      this.setActiveListSublink(null);

      const secondaryContent = this.element.querySelector('.secondary-content') as HTMLElement;
      if (secondaryContent) {
        this.activateSccDefault(getSccDefaultTab());
      }

      // Drop the ?scc= param now that we're back to the scc default.
      this.syncScc();
    }
  }

  /**
   * Mirror the active scc tab into the URL (?scc=) so a reload restores it.
   * Single writer for the param: it reads the actually-active scc tab from the
   * DOM, the one source that spans default tabs, lists, search and view tabs.
   * Only the three scc-visible modes write it; Wide/Phone clear it.
   */
  private syncScc(): void {
    if (!this.layoutService.isSecondaryVisible()) {
      writeSccParam(null);
      return;
    }
    // External follows/followers list active → encode target + mode (its DOM id
    // is the generic `list-follows`, so derive the value from tracked state).
    if (this.externalUserList && this.currentListView?.getContent()?.classList.contains('tab-content--active')) {
      writeSccParam(userListToScc(this.externalUserList.mode, this.externalUserList.pubkey));
      return;
    }
    const sc = this.element.querySelector('.secondary-content');
    const activeId = sc?.querySelector('.tab-content--active')?.getAttribute('data-tab-content') || '';
    let value: string | null = null;
    if (activeId.startsWith('list-')) {
      value = activeId;
    } else if (activeId === 'search-results') {
      value = this.globalSearchView?.getActiveSearchParam() ?? null;
    } else if (activeId && activeId !== 'system-log' && activeId !== 'newest-articles' && activeId !== 'media') {
      // A view tab (snv-/pv-/av-/fpv-/nv/messages) is active.
      const active = this.viewTabManager?.getActiveTab();
      value = active ? viewTypeToPath(active.type, active.param) : null;
    }
    writeSccParam(value);
  }

  /**
   * Reopen the scc content encoded in ?scc= after a reload. Called once after
   * login when layout + modules are ready. View tabs only restore in right-pane.
   */
  public restoreSccFromUrl(): void {
    if (!this.layoutService.isSecondaryVisible()) return;
    const raw = (window as any).__noornote_scc_param ?? readSccParam();
    delete (window as any).__noornote_scc_param;
    if (!raw) return;
    const parsed = parseSccParam(raw);
    if (!parsed) return;
    if (parsed.kind === 'list') {
      this.openListTab(parsed.listType as ListType);
    } else if (parsed.kind === 'user-list') {
      this.openExternalUserListTab(parsed.pubkey, parsed.mode);
    } else if (parsed.kind === 'search') {
      if (parsed.term.startsWith('#')) {
        this.eventBus.emit('hashtagSearch:start', { hashtag: parsed.term.slice(1) });
      } else {
        this.eventBus.emit('globalSearch:start', { query: parsed.term });
      }
    } else if (parsed.kind === 'view' && this.layoutService.isRightPane()) {
      getViewNavigationController().openView(parsed.viewType, parsed.param);
    }
  }

  /**
   * Cleanup resources
   */
  public destroy(): void {
    this.stopCacheSizeUpdates();
    this.stopDateTimeUpdates();

    // Unsubscribe from auth state
    if (this.authStateUnsubscribe) {
      this.authStateUnsubscribe();
    }

    // Cleanup ViewTabManager
    this.cleanupViewTabManager();

    // Stop any active external follower/following sweep.
    this.destroyExternalFollowManager();

    // Destroy managers
    if (this.bookmarkManager) {
      this.bookmarkManager.destroy();
    }

    if (this.badgeManager) {
      this.badgeManager.destroy();
    }

    if (this.hamburgerBadgeManager) {
      this.hamburgerBadgeManager.destroy();
    }

    if (this.userStatus) {
      this.userStatus.destroy();
    }

    if (this.themeSwitcher) {
      this.themeSwitcher.destroy();
    }

    // wallet-balance teardown handled by AddonLoader via user:logout.

    if (this.searchSpotlight) {
      this.searchSpotlight.destroy();
    }

    if (this.pullToRefresh) {
      this.pullToRefresh.destroy();
    }

    this.element.remove();
  }
}
