/**
 * Keyboard Shortcut Manager
 * Handles global keyboard shortcuts for the application
 * Uses Tauri Global Shortcuts API for reliable cross-platform support
 */

import { Router } from './Router';

export class KeyboardShortcutManager {
  private static instance: KeyboardShortcutManager;
  private router: Router;
  private searchModalCallback: (() => void) | null = null;

  private constructor() {
    this.router = Router.getInstance();
    this.setupGlobalShortcuts();
    console.log('[KeyboardShortcutManager] Initialized');
  }

  public static getInstance(): KeyboardShortcutManager {
    if (!KeyboardShortcutManager.instance) {
      KeyboardShortcutManager.instance = new KeyboardShortcutManager();
    }
    return KeyboardShortcutManager.instance;
  }

  /**
   * Register callback for Search modal
   */
  public registerSearchModalCallback(callback: () => void): void {
    this.searchModalCallback = callback;
    console.log('[KeyboardShortcutManager] Search modal callback registered');
  }

  /**
   * Setup global keyboard shortcuts via Tauri events
   */
  private async setupGlobalShortcuts(): Promise<void> {
    // Always setup browser shortcuts (focus-aware)
    this.setupBrowserShortcuts();

    try {
      // Import Tauri event API
      const { listen } = await import('@tauri-apps/api/event');

      // Listen for global shortcuts from Tauri backend (if registered)
      await listen<string>('global-shortcut', (event) => {
        console.log('[KeyboardShortcutManager] Global shortcut received:', event.payload);

        switch (event.payload) {
          case 'search':
          case 'search-alt':
            if (this.searchModalCallback) {
              this.searchModalCallback();
            }
            break;

          case 'navigate-back':
            if (this.router.canGoBack()) {
              this.router.back();
            }
            break;

          case 'navigate-forward':
            if (this.router.canGoForward()) {
              this.router.forward();
            }
            break;
        }
      });

      console.log('[KeyboardShortcutManager] Listening for Tauri global shortcuts');
    } catch (error) {
      console.warn('[KeyboardShortcutManager] Not in Tauri environment');
    }
  }

  /**
   * Fallback: Browser keyboard shortcuts (for non-Tauri environments)
   */
  private setupBrowserShortcuts(): void {
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;

      // Cmd+W: Close active closable tab
      if (isMod && e.key === 'w') {
        e.preventDefault(); // Always prevent default (don't close app window)
        const activeClosableTab = document.querySelector('.tab--closable.tab--active');
        if (activeClosableTab) {
          const closeButton = activeClosableTab.querySelector('.tab__close') as HTMLElement;
          if (closeButton) {
            closeButton.click();
          }
        }
        return;
      }

      // Cmd+Enter OR Cmd+K: Open search modal
      if (isMod && (e.key === 'Enter' || e.key === 'k')) {
        e.preventDefault();
        if (this.searchModalCallback) {
          this.searchModalCallback();
        }
        return;
      }

      if (isMod && e.key === 'ArrowLeft') {
        e.preventDefault();
        if (this.router.canGoBack()) {
          this.router.back();
        }
        return;
      }

      if (isMod && e.key === 'ArrowRight') {
        e.preventDefault();
        if (this.router.canGoForward()) {
          this.router.forward();
        }
        return;
      }
    });
  }
}
