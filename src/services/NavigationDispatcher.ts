/**
 * NavigationDispatcher - single entry point for every "go back / go forward"
 * input source, so all of them are overlay-aware and behave identically.
 *
 * Sources wired here:
 *   - Mouse thumb buttons (button 3 = back, 4 = forward) — Electron only. In a
 *     real browser the thumb buttons already map to native back/forward (handled
 *     via popstate in Router), so wiring them again would double-fire.
 *   - Android hardware back / edge-swipe via the Capacitor App plugin.
 *
 * Browser/Electron UI back and the keyboard shortcuts go through the Router's
 * popstate handler / Router.back() directly; both consult the OverlayStack too.
 */

import { Router } from './Router';
import { OverlayStack } from './OverlayStack';
import { PlatformService } from './PlatformService';

export class NavigationDispatcher {
  private static initialized = false;

  static init(): void {
    if (this.initialized) return;
    this.initialized = true;

    const platform = PlatformService.getInstance();
    if (platform.isElectron) this.setupMouseButtons();
    if (platform.isCapacitor) void this.setupHardwareBack();
  }

  /** Back: dismiss the topmost overlay if any, otherwise navigate back. */
  static goBack(): void {
    if (OverlayStack.closeTopFromInput()) return;
    Router.getInstance().back();
  }

  static goForward(): void {
    Router.getInstance().forward();
  }

  private static setupMouseButtons(): void {
    // Electron's file:// SPA has no meaningful WebContents history, so the native
    // thumb-button back/forward does nothing — route it to the app router instead.
    window.addEventListener('mouseup', (e) => {
      if (e.button === 3) {
        e.preventDefault();
        this.goBack();
      } else if (e.button === 4) {
        e.preventDefault();
        this.goForward();
      }
    });
  }

  private static async setupHardwareBack(): Promise<void> {
    try {
      const { App } = await import('@capacitor/app');
      // Registering a backButton listener overrides Capacitor's default (exit/navigate),
      // so we take full responsibility for it here.
      await App.addListener('backButton', () => {
        if (OverlayStack.closeTopFromInput()) return;
        const router = Router.getInstance();
        if (router.canGoBack()) {
          router.back();
        } else {
          void App.exitApp();
        }
      });
    } catch (error) {
      console.warn('Failed to wire Capacitor hardware back button:', error);
    }
  }
}
