/**
 * ViewNavigationController - Central Authority for View Navigation
 *
 * Single Responsibility: Route ALL view navigation requests
 * - Check LAYOUT_MODE setting (ONE place)
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

import { LayoutService } from './LayoutService';
import { Router } from './Router';
import { ViewTabManager } from './ViewTabManager';
import { getSccDefaultTab } from '../helpers/sccDefaultTab';
import { viewTypeToPath } from '../helpers/sccRoute';

export type ViewType =
  | 'single-note'
  | 'article'
  | 'follow-pack'
  | 'listing'
  | 'profile'
  | 'notifications'
  | 'messages';

export class ViewNavigationController {
  private static instance: ViewNavigationController;
  private layoutService: LayoutService;
  private router: Router;
  private viewTabManager: ViewTabManager | null = null;

  private constructor() {
    this.layoutService = LayoutService.getInstance();
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
   * Analyzes event, checks layout mode, routes appropriately
   */
  public openView(
    viewType: ViewType,
    param?: string,
    event?: MouseEvent
  ): void {
    // Only 'right-pane' mode uses tab system
    if (!this.layoutService.isRightPane()) {
      // Route via traditional Router (for 'default', 'wide', 'mobile' modes)
      this.navigateViaRouter(viewType, param);
      return;
    }

    // 3. Right-pane mode - prevent Router navigation
    // Don't change URL, don't trigger Router
    event?.preventDefault();

    // 4. Initialize ViewTabManager if not already (lazy init)
    if (!this.viewTabManager) {
      this.viewTabManager = ViewTabManager.getInstance();
    }

    // 5. Analyze click type
    const clickMode = this.analyzeClickEvent(event);

    // 6. Delegate to ViewTabManager
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
    const sccDefault = getSccDefaultTab();
    const isDefaultActive = !activeTab || activeTab.id === sccDefault;

    if (isDefaultActive) {
      return 'new-tab';
    }

    return 'replace-active';
  }

  /**
   * Delegate to ViewTabManager (when setting enabled)
   */
  private openInTabSystem(
    viewType: ViewType,
    param: string | undefined,
    clickMode: 'new-tab' | 'replace-active'
  ): void {
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
    return viewTypeToPath(viewType, param);
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
