/**
 * Minimal Vanilla JS Router
 * Handles client-side routing with history API
 */

import { GLOBAL_KEY_HAS_KEY } from '../helpers/globalStorageKeys';
import {
  syncHistoryIndexToPath,
  collapseConsecutiveDuplicates,
} from '../helpers/historyStack';
import { AuthStateManager } from './AuthStateManager';
import { PlatformService } from './PlatformService';
import { OverlayStack } from './OverlayStack';

/** Optional behaviour flags for a single navigate() call. */
export interface NavigateOptions {
  /** Do not record the path on the session back stack (auth redirects). */
  skipHistory?: boolean;
  /** Replace the browser history entry instead of pushing a new one (back/forward). */
  replaceState?: boolean;
}

export interface Route {
  pattern: RegExp;
  handler: (params: Record<string, string>) => void;
  unauthenticatedHandler?: (params: Record<string, string>) => void; // Alternative handler when not authenticated (deprecated - use requiresAuth instead)
  requiresAuth?: boolean; // If true, route requires authentication
  viewClass?: string; // CSS class for body element (e.g., 'tv', 'snv', 'pv')
}

export class Router {
  private static instance: Router;
  private routes: Route[] = [];
  private currentPath: string = '';
  private currentViewClass: string = '';
  private authStateManager: AuthStateManager;
  private history: string[] = [];
  private historyIndex: number = -1;
  private isNavigatingHistory: boolean = false;
  private readonly SESSION_STORAGE_KEY = 'noornote_last_url';
  private readonly HISTORY_STORAGE_KEY = 'noornote_url_history';
  // Mobile (Capacitor) only: mirror of the last route in localStorage, which — unlike
  // sessionStorage — survives Android killing the backgrounded process. Lets a cold start restore
  // where the user was. Timestamped so a genuine later restart starts fresh (see RESTORE_MAX_AGE_MS).
  // Desktop/Web don't have the background-kill problem, so they keep the plain sessionStorage flow.
  private readonly PERSISTENT_STORAGE_KEY = 'noornote_last_url_persistent';
  private readonly RESTORE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h
  private readonly MAX_HISTORY = 50;

  private constructor() {
    this.authStateManager = AuthStateManager.getInstance();

    // Restore URL history from sessionStorage
    this.restoreHistory();

    // Listen for browser back/forward.
    window.addEventListener('popstate', () => {
      // A Back press must first dismiss any open overlay and be consumed there,
      // instead of navigating the view underneath it.
      if (OverlayStack.consumeBackPopstate()) return;
      // Native Back/Forward moved window.history without touching the custom
      // stack — realign the index so the in-app Back button stays in sync.
      this.historyIndex = syncHistoryIndexToPath(
        this.history,
        this.historyIndex,
        window.location.pathname
      );
      this.saveHistory();
      this.handleRoute(window.location.pathname);
    });

    // Don't handle route here - let App.ts call navigate() after routes are registered
  }

  public static getInstance(): Router {
    if (!Router.instance) {
      Router.instance = new Router();
    }
    return Router.instance;
  }

  /**
   * Register a route with pattern and handler
   * @param pattern - Route pattern (e.g., /note/:id)
   * @param handler - Function to call when route matches (authenticated)
   * @param viewClass - CSS class for body element (e.g., 'tv', 'snv', 'pv')
   * @param requiresAuth - If true, route requires authentication (will redirect to home if not authenticated)
   */
  public register(
    pattern: string,
    handler: (params: Record<string, string>) => void,
    viewClass?: string,
    requiresAuth?: boolean | ((params: Record<string, string>) => void) // Backward compatible: accepts boolean or legacy unauthenticatedHandler
  ): void {
    // Convert pattern to regex (e.g., /note/:id -> /note/([^/]+))
    const paramNames: string[] = [];
    const regexPattern = pattern.replace(
      /:([^/]+)/g,
      (_match, paramName: string) => {
        paramNames.push(paramName);
        return '([^/]+)';
      }
    );

    const regex = new RegExp(`^${regexPattern}$`);

    // Handle backward compatibility: if requiresAuth is a function, it's the legacy unauthenticatedHandler
    const isAuthRequired =
      typeof requiresAuth === 'boolean' ? requiresAuth : false;
    const legacyUnauthHandler =
      typeof requiresAuth === 'function' ? requiresAuth : undefined;

    // Build route object with conditional optional properties (exactOptionalPropertyTypes)
    const route: Route = {
      pattern: regex,
      handler: (matches: Record<string, string>) => {
        // Map captured groups to param names
        const params: Record<string, string> = {};
        Object.keys(matches).forEach((key, index) => {
          const paramName = paramNames[index];
          const matchValue = matches[key];
          if (paramName && matchValue) {
            params[paramName] = matchValue;
          }
        });
        handler(params);
      },
    };

    // Only add optional properties if they have values
    if (viewClass) {
      route.viewClass = viewClass;
    }
    if (isAuthRequired) {
      route.requiresAuth = isAuthRequired;
    }
    if (legacyUnauthHandler) {
      route.unauthenticatedHandler = (matches: Record<string, string>) => {
        // Map captured groups to param names
        const params: Record<string, string> = {};
        Object.keys(matches).forEach((key, index) => {
          const paramName = paramNames[index];
          const matchValue = matches[key];
          if (paramName && matchValue) {
            params[paramName] = matchValue;
          }
        });
        legacyUnauthHandler(params);
      };
    }

    this.routes.push(route);
  }

  /**
   * Navigate to a new route
   * @param path - Path to navigate to (e.g., /note/abc123)
   * @param force - Force re-render even if already on this path (e.g., after auth state change)
   * @param opts - Optional flags: skipHistory (auth redirects), replaceState (back/forward)
   */
  public navigate(
    path: string,
    force: boolean = false,
    opts?: NavigateOptions
  ): void {
    if (path === this.currentPath && !force) {
      return; // Already on this route
    }

    // Emit event for SystemLogger to clear page logs (avoid circular dependency)
    if (path !== this.currentPath) {
      window.dispatchEvent(
        new CustomEvent('router:navigate', {
          detail: { path, previousPath: this.currentPath },
        })
      );
    }

    // Update navigation history (only if not navigating via back/forward)
    if (
      !this.isNavigatingHistory &&
      path !== this.currentPath &&
      !opts?.skipHistory
    ) {
      // Remove all forward history when navigating to new page
      this.history = this.history.slice(0, this.historyIndex + 1);

      // Consecutive-duplicate guard: an app reload re-pushes the restored
      // path — without this, Back would need one press per reload for the
      // same step. If the top entry already is the path, just stay on it.
      if (this.history[this.historyIndex] !== path) {
        // Add new path to history
        this.history.push(path);

        // Limit history size
        if (this.history.length > this.MAX_HISTORY) {
          this.history.shift();
        } else {
          this.historyIndex++;
        }
      }

      // Persist history to sessionStorage
      this.saveHistory();
    }

    // Update browser history (only if path changed).
    if (path !== this.currentPath) {
      // The browser may have already navigated to this URL (e.g. on boot
      // after a full page-load via `window.location.href`). Pushing
      // again would create a duplicate history entry, so the user would
      // need TWO Back-button presses to leave. Detect and use
      // replaceState in that case. Back/forward moves ALWAYS replace:
      // the custom stack is the source of truth, so the browser entry
      // must be rewritten in place instead of growing the native history.
      // Preserve the secondary-pane state (?scc=) across pcc navigation so the
      // scc tab survives sidebar navigation and reload. The scc param itself is
      // written by MainLayout; here we only carry it through.
      const scc = new URLSearchParams(window.location.search).get('scc');
      const targetUrl = scc ? `${path}?scc=${encodeURIComponent(scc)}` : path;
      if (opts?.replaceState || window.location.pathname === path) {
        window.history.replaceState({}, '', targetUrl);
      } else {
        window.history.pushState({}, '', targetUrl);
      }
    }

    // Persist current URL for reload (sessionStorage) and, on native, for cold-start restore.
    sessionStorage.setItem(this.SESSION_STORAGE_KEY, path);
    this.persistRoute(path);

    // Handle the route
    this.handleRoute(path);
  }

  /**
   * Replace the current URL in place (no new history entry, no re-render).
   * Used to canonicalize a URL that already maps to the current view — e.g. a note
   * reached as /note/<hex> or /note/<nevent-with-relay-hints> is normalised to its
   * one canonical /note/<nevent> form, so the same note never piles up as multiple
   * history entries the Back button has to step through.
   */
  public replaceUrl(path: string): void {
    if (path === this.currentPath) return;

    // Preserve the secondary-pane state (?scc=) just like navigate() does.
    const scc = new URLSearchParams(window.location.search).get('scc');
    const targetUrl = scc ? `${path}?scc=${encodeURIComponent(scc)}` : path;
    window.history.replaceState({}, '', targetUrl);

    // Keep the custom history stack consistent: rewrite the current top entry.
    if (
      this.historyIndex >= 0 &&
      this.history[this.historyIndex] !== undefined
    ) {
      this.history[this.historyIndex] = path;
      this.saveHistory();
    }

    this.currentPath = path;
    sessionStorage.setItem(this.SESSION_STORAGE_KEY, path);
    this.persistRoute(path);
  }

  /**
   * Go back in history
   */
  public back(): void {
    if (this.canGoBack()) {
      this.isNavigatingHistory = true;
      this.historyIndex--;
      const path = this.history[this.historyIndex];
      if (path) {
        this.navigate(path, false, { replaceState: true });
      }
      this.isNavigatingHistory = false;
    }
  }

  /**
   * Go forward in history
   */
  public forward(): void {
    if (this.canGoForward()) {
      this.isNavigatingHistory = true;
      this.historyIndex++;
      const path = this.history[this.historyIndex];
      if (path) {
        this.navigate(path, false, { replaceState: true });
      }
      this.isNavigatingHistory = false;
    }
  }

  /**
   * Check if can go back
   */
  public canGoBack(): boolean {
    return this.historyIndex > 0;
  }

  /**
   * Check if can go forward
   */
  public canGoForward(): boolean {
    return this.historyIndex < this.history.length - 1;
  }

  /**
   * Get navigation history (for URL modal suggestions)
   */
  public getHistory(): string[] {
    return [...this.history];
  }

  /**
   * Get current path
   */
  public getCurrentPath(): string {
    return this.currentPath;
  }

  /**
   * Get last visited URL from sessionStorage (for reload)
   */
  public getLastURL(): string | null {
    return sessionStorage.getItem(this.SESSION_STORAGE_KEY);
  }

  /**
   * Mobile (Capacitor) cold-start fallback: the last route from localStorage, but only if
   * it was visited within RESTORE_MAX_AGE_MS. This survives Android killing the backgrounded process
   * (sessionStorage does not), so the user lands back where they were instead of on the home view.
   * A genuinely later restart is past the window and starts fresh. Stale entries are cleared.
   * Returns null on desktop/web (the entry is only ever written on Capacitor).
   */
  public getPersistedURL(): string | null {
    if (!PlatformService.getInstance().isCapacitor) return null;
    try {
      const stored = localStorage.getItem(this.PERSISTENT_STORAGE_KEY);
      if (!stored) return null;
      const { path, ts } = JSON.parse(stored) as { path: string; ts: number };
      if (typeof path !== 'string' || typeof ts !== 'number') return null;
      if (Date.now() - ts > this.RESTORE_MAX_AGE_MS) {
        localStorage.removeItem(this.PERSISTENT_STORAGE_KEY);
        return null;
      }
      return path;
    } catch {
      return null;
    }
  }

  /**
   * Mirror the current route to localStorage with a timestamp (Capacitor/mobile only) so a cold
   * start can restore it. No-op on desktop/web, where the background-kill problem doesn't exist and
   * sessionStorage already covers reloads (plus per-tab independence on web is desirable).
   */
  private persistRoute(path: string): void {
    if (!PlatformService.getInstance().isCapacitor) return;
    try {
      localStorage.setItem(
        this.PERSISTENT_STORAGE_KEY,
        JSON.stringify({ path, ts: Date.now() })
      );
    } catch (error) {
      console.debug('Failed to persist route for cold-start restore:', error);
    }
  }

  /**
   * Save history to sessionStorage
   */
  private saveHistory(): void {
    try {
      sessionStorage.setItem(
        this.HISTORY_STORAGE_KEY,
        JSON.stringify({
          history: this.history,
          index: this.historyIndex,
        })
      );
    } catch (error) {
      console.debug('Failed to save navigation history:', error);
    }
  }

  /**
   * Restore history from sessionStorage
   */
  private restoreHistory(): void {
    try {
      const stored = sessionStorage.getItem(this.HISTORY_STORAGE_KEY);
      if (stored) {
        // Own sessionStorage history format (see persistHistory)
        const data = JSON.parse(stored) as {
          history?: string[];
          index?: number;
        };
        // Collapse reload-induced consecutive duplicates from older sessions
        const collapsed = collapseConsecutiveDuplicates(
          data.history ?? [],
          data.index ?? -1
        );
        this.history = collapsed.history;
        this.historyIndex = collapsed.index;
      }
    } catch (error) {
      console.debug('Failed to restore navigation history:', error);
    }
  }

  /**
   * Handle route matching and execution
   */
  private handleRoute(path: string): void {
    this.currentPath = path;

    // Find matching route
    for (const route of this.routes) {
      const match = path.match(route.pattern);
      if (match) {
        // Update body class for view-specific CSS
        this.updateBodyViewClass(route.viewClass);

        // Extract params (skip first match which is full string)
        const params: Record<string, string> = {};
        for (let i = 1; i < match.length; i++) {
          const matchValue = match[i];
          if (matchValue !== undefined) {
            params[i.toString()] = matchValue;
          }
        }

        // Check if route requires authentication
        if (!this.authStateManager.isLoggedIn()) {
          // User not logged in
          if (route.unauthenticatedHandler) {
            // Legacy: Use custom unauthenticated handler
            route.unauthenticatedHandler(params);
          } else if (route.requiresAuth) {
            // Route requires auth - redirect to welcome or login based on user preference.
            // Auth redirects are system actions, not user navigation — they must NOT
            // land on the back stack (the user cannot go "back" to a login gate).
            const hasKey = localStorage.getItem(GLOBAL_KEY_HAS_KEY);
            this.navigate(hasKey ? '/login' : '/welcome', false, {
              skipHistory: true,
            });
          } else {
            // Route is public, show it
            route.handler(params);
          }
        } else {
          // User logged in, show route
          route.handler(params);
        }
        this.notifyHistoryChanged();
        return;
      }
    }

    // No route matched - show 404 or default route
    console.debug(`No route matched for: ${path}`);
    this.notifyHistoryChanged();
  }

  /**
   * Fired after every routed navigation (navigate, back/forward, native popstate).
   * Signals UI chrome (e.g. the pcc back bar) to re-evaluate canGoBack().
   */
  private notifyHistoryChanged(): void {
    window.dispatchEvent(new CustomEvent('router:history-changed'));
  }

  /**
   * Get current view class (for filtering debug logs by view)
   */
  public getCurrentView(): string {
    return this.currentViewClass;
  }

  /**
   * Update body element class for view-specific CSS
   */
  private updateBodyViewClass(newViewClass?: string): void {
    const body = document.body;

    // Remove previous view class
    if (this.currentViewClass) {
      body.classList.remove(this.currentViewClass);
    }

    // Add new view class
    if (newViewClass) {
      body.classList.add(newViewClass);
      this.currentViewClass = newViewClass;
    } else {
      this.currentViewClass = '';
    }

    // Dispatch custom event for view change (for SystemLogger filtering)
    window.dispatchEvent(
      new CustomEvent('router:view-changed', {
        detail: { view: this.currentViewClass },
      })
    );
  }
}
