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
import { ViewLifecycleManager } from './ViewLifecycleManager';
import { SystemLogger } from '../components/system/SystemLogger';

type ViewFactory = (param?: string) => Promise<{ element: HTMLElement; view?: View }>;

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

    const { element, view } = await config.factory(param);
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
            return { element: view.getElement() };
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

      default:
        return null;
    }
  }
}
