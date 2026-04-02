/**
 * Keyboard Shortcut Manager
 * Handles global keyboard shortcuts for the application
 * Uses Electron IPC for reliable cross-platform support
 */

import { Router } from './Router';
import { ModalService } from './ModalService';
import { PlatformService } from './PlatformService';

export class KeyboardShortcutManager {
  private static instance: KeyboardShortcutManager;
  private router: Router;
  private searchModalCallback: (() => void) | null = null;

  private constructor() {
    this.router = Router.getInstance();
    this.setupGlobalShortcuts();
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
  }

  /**
   * Check if shortcuts should be blocked (modal open or focus in input)
   */
  private shouldBlockShortcuts(): boolean {
    if (ModalService.getInstance().isOpen()) return true;

    // Block if focus is in input/textarea/contenteditable
    const active = document.activeElement;
    if (!active) return false;

    const tag = active.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || active.getAttribute('contenteditable') === 'true';
  }

  /**
   * Setup global keyboard shortcuts via Electron IPC
   */
  private async setupGlobalShortcuts(): Promise<void> {
    // Always setup browser shortcuts (focus-aware)
    this.setupBrowserShortcuts();

    const _p = PlatformService.getInstance();
    if (!_p.isDesktop) return;

    try {
      const handleShortcut = (action: string) => {
        if (this.shouldBlockShortcuts()) return;

        switch (action) {
          case 'search':
          case 'search-alt':
            if (this.searchModalCallback) this.searchModalCallback();
            break;
          case 'navigate-back':
            if (this.router.canGoBack()) this.router.back();
            break;
          case 'navigate-forward':
            if (this.router.canGoForward()) this.router.forward();
            break;
        }
      };

      if (_p.isElectron) {
        window.electronAPI!.onGlobalShortcut((action: string) => handleShortcut(action));
      }
    } catch {
      // Global shortcut API unavailable
    }
  }

  /**
   * Browser keyboard shortcuts (fallback for non-desktop environments)
   */
  private setupBrowserShortcuts(): void {
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;

      // Cmd+W: Close active closable tab (always allow, even in modals)
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

      // Block all other shortcuts if modal is open or focus is in input
      if (this.shouldBlockShortcuts()) {
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
