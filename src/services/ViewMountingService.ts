/**
 * ViewMountingService
 *
 * Data-driven view registry and mounting orchestration.
 * Replaces the switch statement in App.ts with a declarative view map.
 *
 * Owns:
 * - View registry (viewType -> factory/config)
 * - View caching (timeline, profile)
 * - View lifecycle coordination (mount/unmount via ViewLifecycleManager)
 */

import type { View } from '../components/views/View';
import type { MainLayout } from '../components/layout/MainLayout';
import { Router } from './Router';
import { ViewLifecycleManager } from './ViewLifecycleManager';
import { SystemLogger } from './SystemLogger';

type ViewFactory = (param?: string) => Promise<{ element: HTMLElement; view?: View } | null>;

interface ViewConfig {
  factory: ViewFactory;
  requiresParam?: boolean;
}

export class ViewMountingService {
  private static instance: ViewMountingService;

  private viewLifecycleManager = ViewLifecycleManager.getInstance();
  private systemLogger = SystemLogger.getInstance();
  private mainLayout: MainLayout | null = null;

  // Cached view instances (survive navigation, destroyed on logout/relay change)
  private cachedTimeline: View | null = null;
  private cachedProfile: (View & { getNpub(): string }) | null = null;

  private constructor() {}

  public static getInstance(): ViewMountingService {
    if (!ViewMountingService.instance) {
      ViewMountingService.instance = new ViewMountingService();
    }
    return ViewMountingService.instance;
  }

  public setMainLayout(layout: MainLayout): void {
    this.mainLayout = layout;
  }

  /**
   * Mount a view by type into .primary-content
   */
  public async mountView(viewType: string, param?: string): Promise<void> {
    const primaryContent = document.querySelector('.primary-content');
    if (!primaryContent) return;

    this.unmountCachedViews(primaryContent);

    // Cleanup welcome page resources when navigating away
    if (viewType !== 'welcome' && this.mainLayout) {
      this.mainLayout.cleanupWelcome();
    }

    this.systemLogger.clearPageLogs();
    primaryContent.innerHTML = '';

    // MainLayout-delegated views (onboarding screens)
    if (this.mountLayoutView(viewType)) return;

    // Data-driven view creation
    const config = this.getViewConfig(viewType);
    if (!config) return;
    if (config.requiresParam && !param) return;

    const result = await config.factory(param);
    if (!result) return;
    const { element, view } = result;
    primaryContent.appendChild(element);

    if (view) {
      this.viewLifecycleManager.onViewMount(view);
    }
  }

  public destroyTimelineCache(): void {
    if (this.cachedTimeline) {
      this.cachedTimeline.destroy();
      this.cachedTimeline = null;
    }
  }

  public destroyAllCaches(): void {
    this.destroyTimelineCache();
    if (this.cachedProfile) {
      this.cachedProfile.destroy();
      this.cachedProfile = null;
    }
  }

  private unmountCachedViews(container: Element): void {
    if (this.cachedTimeline && this.viewLifecycleManager.isViewMounted(this.cachedTimeline, container)) {
      this.viewLifecycleManager.onViewUnmount(this.cachedTimeline);
    }
    if (this.cachedProfile && this.viewLifecycleManager.isViewMounted(this.cachedProfile, container)) {
      this.viewLifecycleManager.onViewUnmount(this.cachedProfile);
    }
  }

  /**
   * Delegates onboarding views to MainLayout.
   * Returns true if the viewType was handled, false otherwise.
   */
  private mountLayoutView(viewType: string): boolean {
    if (!this.mainLayout) return false;

    switch (viewType) {
      case 'welcome':
        this.mainLayout.showWelcomeScreen();
        return true;
      case 'create-account':
        this.mainLayout.showCreateAccountScreen();
        return true;
      case 'not-logged-in':
        this.mainLayout.showLoginScreen();
        return true;
      case 'profile-setup':
        this.mainLayout.showAccountSetupWizard();
        return true;
      default:
        return false;
    }
  }

  private getViewConfig(viewType: string): ViewConfig | null {
    switch (viewType) {
      case 'timeline':
        return {
          factory: async () => {
            if (!this.cachedTimeline) {
              const { TimelineView } = await import('../components/views/TimelineView');
              this.cachedTimeline = new TimelineView();
            }
            return { element: this.cachedTimeline.getElement(), view: this.cachedTimeline };
          }
        };

      case 'single-note':
        return {
          requiresParam: true,
          factory: async (param) => {
            const { SingleNoteView } = await import('../components/views/SingleNoteView');
            const view = new SingleNoteView(param!);
            return { element: view.getElement() };
          }
        };

      case 'profile':
        return {
          requiresParam: true,
          factory: async (param) => {
            if (!this.cachedProfile || this.cachedProfile.getNpub() !== param) {
              const { ProfileView } = await import('../components/views/ProfileView');
              this.cachedProfile = new ProfileView(param!);
            }
            return { element: this.cachedProfile.getElement(), view: this.cachedProfile };
          }
        };

      case 'article':
        return {
          requiresParam: true,
          factory: async (param) => {
            const { ArticleView } = await import('../components/views/ArticleView');
            const view = new ArticleView(param!);
            return { element: view.getElement() };
          }
        };

      case 'nospress':
        return {
          factory: async () => {
            const { NospressView } = await import('../addons/nospress/NospressView');
            const { AuthService } = await import('./AuthService');
            const npub = AuthService.getInstance().getCurrentUser()?.npub ?? '';
            const view = new NospressView(npub);
            return { element: view.getElement(), view };
          }
        };

      case 'follow-pack':
        return {
          requiresParam: true,
          factory: async (param) => {
            const { FollowPackDetailView } = await import('../components/views/FollowPackDetailView');
            const view = new FollowPackDetailView(param!);
            return { element: view.getElement() };
          }
        };

      case 'zapstore':
        return {
          requiresParam: true,
          factory: async (param) => {
            const { ZapstoreAppView } = await import('../components/views/ZapstoreAppView');
            const view = new ZapstoreAppView(param!);
            return { element: view.getElement() };
          }
        };

      case 'notifications':
        return {
          factory: async () => {
            const { NotificationsView } = await import('../components/views/NotificationsView');
            const view = new NotificationsView();
            return { element: view.getElement() };
          }
        };

      case 'settings':
        return {
          factory: async () => {
            const { SettingsView } = await import('../components/views/SettingsView');
            const view = new SettingsView();
            return { element: view.getElement(), view };
          }
        };

      case 'settings-ui':
        return {
          factory: async () => {
            const { UISettingsView } = await import('../components/views/settings/UISettingsView');
            const view = new UISettingsView();
            return { element: view.getElement(), view };
          }
        };

      case 'settings-notif':
        return {
          factory: async () => {
            const { NotificationPrioritiesView } = await import('../components/views/settings/NotificationPrioritiesView');
            const view = new NotificationPrioritiesView();
            return { element: view.getElement(), view };
          }
        };

      case 'settings-relays':
        return {
          factory: async () => {
            const { RelaySettingsView } = await import('../components/views/settings/RelaySettingsView');
            const view = new RelaySettingsView();
            return { element: view.getElement(), view };
          }
        };

      case 'settings-key-signer':
        return {
          factory: async () => {
            const { KeySignerView } = await import('../components/views/settings/KeySignerView');
            const view = new KeySignerView();
            return { element: view.getElement(), view };
          }
        };

      case 'settings-media':
        return {
          factory: async () => {
            const { MediaSettingsView } = await import('../components/views/settings/MediaSettingsView');
            const view = new MediaSettingsView();
            return { element: view.getElement(), view };
          }
        };

      case 'settings-zaps':
        return {
          factory: async () => {
            const { NWCSettingsView } = await import('../components/views/settings/NWCSettingsView');
            const view = new NWCSettingsView();
            return { element: view.getElement(), view };
          }
        };

      case 'settings-privacy':
        return {
          factory: async () => {
            const { PrivacySettingsView } = await import('../components/views/settings/PrivacySettingsView');
            const view = new PrivacySettingsView();
            return { element: view.getElement(), view };
          }
        };

      case 'settings-cache':
        return {
          factory: async () => {
            const { CacheSettingsView } = await import('../components/views/settings/CacheSettingsView');
            const view = new CacheSettingsView();
            return { element: view.getElement(), view };
          }
        };

      case 'about':
        return {
          factory: async () => {
            const { AboutView } = await import('../components/views/AboutView');
            const view = new AboutView();
            return { element: view.getElement() };
          }
        };

      case 'write-article':
        return {
          factory: async () => {
            const { ArticleEditorView } = await import('../components/views/ArticleEditorView');
            const view = new ArticleEditorView();
            return { element: view.getElement() };
          }
        };

      case 'edit-article':
        return {
          requiresParam: true,
          factory: async (param) => {
            const { ArticleEditorView } = await import('../components/views/ArticleEditorView');
            const view = new ArticleEditorView(param!);
            return { element: view.getElement() };
          }
        };

      case 'write-video':
        return {
          factory: async () => {
            const { VideoEditorView } = await import('../components/views/VideoEditorView');
            const view = new VideoEditorView();
            return { element: view.getElement() };
          }
        };

      case 'relay-browser':
        return {
          requiresParam: true,
          factory: async (param) => {
            const { RelayBrowserView } = await import('../components/views/RelayBrowserView');
            const view = new RelayBrowserView(param!);
            return { element: view.getElement() };
          }
        };

      case 'articles':
        return {
          factory: async () => {
            const { ArticleTimelineView } = await import('../components/views/ArticleTimelineView');
            const view = new ArticleTimelineView();
            return { element: view.getElement() };
          }
        };

      case 'tribes':
        return {
          factory: async () => {
            const { TribeView } = await import('../lists/tribes');
            const view = new TribeView();
            return { element: view.getElement() };
          }
        };

      case 'mute-list':
        return {
          factory: async () => {
            const { MuteListView } = await import('../lists/mutes');
            const view = new MuteListView();
            return { element: await view.render() };
          }
        };

      case 'messages':
        return {
          factory: async () => {
            const { MessagesView } = await import('../components/views/MessagesView');
            const view = new MessagesView();
            return { element: view.getElement() };
          }
        };

      case 'conversation':
        return {
          requiresParam: true,
          factory: async (param) => {
            const { ConversationView } = await import('../components/views/ConversationView');
            const view = new ConversationView(param!);
            return { element: view.getElement() };
          }
        };

      case 'addon-bookmarks':
        return {
          factory: async () => {
            const { BookmarksAddonView } = await import('../addons/bookmarks/BookmarksAddonView');
            const view = new BookmarksAddonView();
            return { element: view.getElement(), view };
          }
        };

      case 'addon-tribes':
        return {
          factory: async () => {
            const { TribesAddonView } = await import('../addons/tribes/TribesAddonView');
            const view = new TribesAddonView();
            return { element: view.getElement(), view };
          }
        };

      case 'addon-extended-follows':
        return {
          factory: async () => {
            const { ExtendedFollowsAddonView } = await import('../addons/extended-follows/ExtendedFollowsAddonView');
            const view = new ExtendedFollowsAddonView();
            return { element: view.getElement(), view };
          }
        };

      case 'addon-wallet-balance':
        return {
          factory: async () => {
            const { WalletBalanceAddonView } = await import('../addons/wallet-balance/WalletBalanceAddonView');
            const view = new WalletBalanceAddonView();
            return { element: view.getElement(), view };
          }
        };

      case 'addon-profile-recognition':
        return {
          factory: async () => {
            const { ProfileRecognitionView } = await import('../addons/profile-recognition/ProfileRecognitionView');
            const view = new ProfileRecognitionView();
            return { element: view.getElement(), view };
          }
        };

      case 'addon-marketplace':
        return {
          factory: async () => {
            const { MarketplaceAddonView } = await import('../addons/marketplace/MarketplaceAddonView');
            const view = new MarketplaceAddonView();
            return { element: view.getElement(), view };
          }
        };

      case 'addon-follow-packs':
        return {
          factory: async () => {
            const { FollowPacksView } = await import('../addons/follow-packs/FollowPacksView');
            const view = new FollowPacksView();
            return { element: view.getElement(), view };
          }
        };

      case 'addon-nospress':
        return {
          factory: async () => {
            const { NospressAddonView } = await import('../addons/nospress/NospressAddonView');
            const view = new NospressAddonView();
            return { element: view.getElement(), view };
          }
        };

      case 'addon-hashtag-subscriptions':
        return {
          factory: async () => {
            const { HashtagSubscriptionsAddonView } = await import('../addons/hashtag-subscriptions/HashtagSubscriptionsAddonView');
            const view = new HashtagSubscriptionsAddonView();
            return { element: view.getElement(), view };
          }
        };

      case 'addon-list-settings':
        return {
          factory: async () => {
            const { ListSettingsAddonView } = await import('../addons/list-settings/ListSettingsAddonView');
            const view = new ListSettingsAddonView();
            return { element: view.getElement(), view };
          }
        };

      case 'addon-custom-emojis':
        return {
          factory: async () => {
            const { CustomEmojisView } = await import('../addons/custom-emojis/CustomEmojisView');
            const view = new CustomEmojisView();
            return { element: view.getElement(), view };
          }
        };

      case 'addon-wordfilter':
        return {
          factory: async () => {
            const { WordFilterAddonView } = await import('../addons/content-word-filter/WordFilterAddonView');
            const view = new WordFilterAddonView();
            return { element: view.getElement(), view };
          }
        };

      case 'addon-live-streams-player':
        return {
          factory: async () => {
            const { LiveStreamsPlayerAddonView } = await import('../addons/live-streams-player/LiveStreamsPlayerAddonView');
            const view = new LiveStreamsPlayerAddonView();
            return { element: view.getElement(), view };
          }
        };

      case 'addon-scheduled-posts':
        return {
          factory: async () => {
            const { ScheduledPostsAddonView } = await import('../addons/scheduled-posts/ScheduledPostsAddonView');
            const view = new ScheduledPostsAddonView();
            return { element: view.getElement(), view };
          }
        };

      case 'addon-badges':
        return {
          factory: async () => {
            const { BadgesView } = await import('../addons/badges/BadgesView');
            const view = new BadgesView();
            return { element: view.getElement(), view };
          }
        };

      case 'marketplace':
        return {
          factory: async () => {
            const { isMarketplaceEnabled } = await import('../addons/marketplace/index');
            if (!isMarketplaceEnabled()) {
              Router.getInstance().navigate('/');
              return null;
            }
            const { MarketplaceView } = await import('../addons/marketplace/MarketplaceView');
            const view = new MarketplaceView();
            return { element: view.getElement() };
          }
        };

      case 'listing':
        return {
          requiresParam: true,
          factory: async (param) => {
            const { isMarketplaceEnabled } = await import('../addons/marketplace/index');
            if (!isMarketplaceEnabled()) {
              Router.getInstance().navigate('/');
              return null;
            }
            const { ListingView } = await import('../addons/marketplace/ListingView');
            const view = new ListingView(param!);
            return { element: view.getElement() };
          }
        };

      case 'write-listing':
        return {
          factory: async () => {
            const { isMarketplaceEnabled } = await import('../addons/marketplace/index');
            if (!isMarketplaceEnabled()) {
              Router.getInstance().navigate('/');
              return null;
            }
            const { ListingEditorView } = await import('../addons/marketplace/ListingEditorView');
            const view = new ListingEditorView();
            return { element: view.getElement() };
          }
        };

      case 'edit-listing':
        return {
          requiresParam: true,
          factory: async (param) => {
            const { isMarketplaceEnabled } = await import('../addons/marketplace/index');
            if (!isMarketplaceEnabled()) {
              Router.getInstance().navigate('/');
              return null;
            }
            const { ListingEditorView } = await import('../addons/marketplace/ListingEditorView');
            const view = new ListingEditorView(param!);
            return { element: view.getElement() };
          }
        };

      case 'my-listings':
        return {
          factory: async () => {
            const { isMarketplaceEnabled } = await import('../addons/marketplace/index');
            if (!isMarketplaceEnabled()) {
              Router.getInstance().navigate('/');
              return null;
            }
            const { MyListingsView } = await import('../addons/marketplace/MyListingsView');
            const view = new MyListingsView();
            return { element: view.getElement() };
          }
        };

      default:
        return null;
    }
  }
}
