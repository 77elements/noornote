/**
 * ViewNavigationController - Central Authority for View Navigation
 *
 * Single Responsibility: Route ALL view navigation requests
 * - Check VIEW_TABS_RIGHT_PANE setting (ONE place)
 * - Analyze click events (single/double/middle/modifier)
 * - Delegate to Tab System OR Router
 *
 * Benefits:
 * - Click handlers stay simple (ONE method call)
 * - Setting check in ONE place (not scattered)
 * - Easy to test (mock controller)
 * - No code duplication
 *
 * @service ViewNavigationController
 */

import { PerAccountLocalStorage, StorageKeys } from './PerAccountLocalStorage';
import { Router } from './Router';
import { ViewTabManager } from './ViewTabManager';

export type ViewType = 'single-note' | 'profile' | 'notifications' | 'messages';

export class ViewNavigationController {
  private static instance: ViewNavigationController;
  private storage: PerAccountLocalStorage;
  private router: Router;
  private viewTabManager: ViewTabManager | null = null;

  private constructor() {
    this.storage = PerAccountLocalStorage.getInstance();
    this.router = Router.getInstance();
  }

  public static getInstance(): ViewNavigationController {
    if (!ViewNavigationController.instance) {
      ViewNavigationController.instance = new ViewNavigationController();
    }
    return ViewNavigationController.instance;
  }

  /**
   * CENTRAL navigation method - called by ALL click handlers
   * Analyzes event, checks setting, routes appropriately
   */
  public openView(viewType: ViewType, param?: string, event?: MouseEvent): void {
    // 1. Check setting
    const tabModeEnabled = this.storage.get<boolean>(StorageKeys.VIEW_TABS_RIGHT_PANE, false);

    if (!tabModeEnabled) {
      // Route via traditional Router
      this.navigateViaRouter(viewType, param);
      return;
    }

    // 2. Tab mode enabled - prevent Router navigation
    // Don't change URL, don't trigger Router
    event?.preventDefault();

    // 3. Initialize ViewTabManager if not already (lazy init)
    if (!this.viewTabManager) {
      this.viewTabManager = ViewTabManager.getInstance();
    }

    // 4. Analyze click type
    const clickMode = this.analyzeClickEvent(event);

    // 5. Delegate to ViewTabManager
    this.openInTabSystem(viewType, param, clickMode);
  }

  /**
   * Analyze click event to determine navigation mode
   * Returns 'new-tab' or 'replace-active'
   */
  private analyzeClickEvent(event?: MouseEvent): 'new-tab' | 'replace-active' {
    if (!event) {
      // Programmatic navigation (no click event)
      return 'new-tab';
    }

    // Check for special click types that always open new tabs
    const isMiddleClick = event.button === 1;
    const isModifierClick = event.metaKey || event.ctrlKey;
    const isDoubleClick = event.detail === 2;

    if (isMiddleClick || isModifierClick || isDoubleClick) {
      return 'new-tab';
    }

    // Single click - check if System Log is active
    // If System Log is active, open new tab (don't replace System Log)
    // If a view tab is active, replace it
    if (!this.viewTabManager) {
      return 'new-tab';
    }

    const activeTab = this.viewTabManager.getActiveTab();
    const isSystemLogActive = !activeTab || activeTab.id === 'system-log';

    if (isSystemLogActive) {
      return 'new-tab'; // Don't replace System Log
    }

    return 'replace-active';
  }

  /**
   * Delegate to ViewTabManager (when setting enabled)
   */
  private openInTabSystem(viewType: ViewType, param?: string, clickMode: 'new-tab' | 'replace-active'): void {
    if (!this.viewTabManager) return;

    const replaceActive = clickMode === 'replace-active';
    this.viewTabManager.openTab(viewType, param, replaceActive);
  }

  /**
   * Delegate to Router (when setting disabled)
   */
  private navigateViaRouter(viewType: ViewType, param?: string): void {
    const path = this.buildRoutePath(viewType, param);
    this.router.navigate(path);
  }

  /**
   * Build route path for Router navigation
   */
  private buildRoutePath(viewType: ViewType, param?: string): string {
    switch (viewType) {
      case 'single-note':
        return `/note/${param}`;
      case 'profile':
        return `/profile/${param}`;
      case 'notifications':
        return '/notifications';
      case 'messages':
        return '/messages';
      default:
        return '/';
    }
  }

  /**
   * Cleanup (e.g., on logout)
   */
  public cleanup(): void {
    if (this.viewTabManager) {
      this.viewTabManager.closeAllTabs();
      this.viewTabManager = null;
    }
  }
}

/**
 * Singleton export for convenience
 */
export function getViewNavigationController(): ViewNavigationController {
  return ViewNavigationController.getInstance();
}
