/**
 * Keyboard Shortcut Manager
 * Handles global keyboard shortcuts for the application
 * Uses Electron IPC for reliable cross-platform support
 */

import { ModalService } from './ModalService';
import { PlatformService } from './PlatformService';
import { NavigationDispatcher } from './NavigationDispatcher';

export class KeyboardShortcutManager {
  private static instance: KeyboardShortcutManager;
  private searchModalCallback: (() => void) | null = null;

  private constructor() {
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
    return ModalService.getInstance().isOpen() || this.isTextInputFocused();
  }

  /**
   * True when focus sits in a text field, where keys like Cmd/Ctrl+Arrow carry a
   * native caret meaning and must not be hijacked as app shortcuts.
   */
  private isTextInputFocused(): boolean {
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
        switch (action) {
          case 'search':
          case 'search-alt':
            if (this.shouldBlockShortcuts()) return;
            if (this.searchModalCallback) this.searchModalCallback();
            break;
          case 'navigate-back':
            // Overlay-aware Back: dismisses the topmost overlay (image viewer, or
            // a modal → its close guard, e.g. the note composer's draft prompt)
            // before navigating. Skipped while typing in a text field.
            if (this.isTextInputFocused()) return;
            NavigationDispatcher.goBack();
            break;
          case 'navigate-forward':
            if (this.isTextInputFocused()) return;
            NavigationDispatcher.goForward();
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

      // Cmd/Ctrl+ArrowLeft / ArrowRight = overlay-aware Back / Forward. Handled
      // before the modal/input gate so it can also dismiss overlays (image viewer,
      // or a dirty note composer → "Save as draft?"). Skipped while a text field
      // is focused so the native caret line-navigation keeps working.
      if (isMod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        if (this.isTextInputFocused()) return;
        e.preventDefault();
        if (e.key === 'ArrowLeft') {
          NavigationDispatcher.goBack();
        } else {
          NavigationDispatcher.goForward();
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
    });
  }
}
