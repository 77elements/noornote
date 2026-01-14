/**
 * LayoutService - Central Layout Mode Management
 *
 * Single source of truth for layout state:
 * - Manages current layout mode ('default' | 'right-pane' | 'wide' | 'phone')
 * - Sets CSS class on <html> element for CSS-driven styling
 * - Emits 'layout:changed' event for reactive updates
 * - Handles Tauri window resize for phone mode
 *
 * @service LayoutService
 * @purpose Centralize layout mode logic, reduce scattered getLayoutMode() calls
 */

import { PerAccountLocalStorage, type LayoutMode } from './PerAccountLocalStorage';
import { EventBus } from './EventBus';
import { PlatformService } from './PlatformService';

export class LayoutService {
  private static instance: LayoutService;
  private storage: PerAccountLocalStorage;
  private eventBus: EventBus;
  private currentMode: LayoutMode = 'default';
  private previousWindowWidth: number | null = null;

  private constructor() {
    this.storage = PerAccountLocalStorage.getInstance();
    this.eventBus = EventBus.getInstance();
    this.currentMode = this.storage.getLayoutMode();
    this.applyLayoutClass();
  }

  public static getInstance(): LayoutService {
    if (!LayoutService.instance) {
      LayoutService.instance = new LayoutService();
    }
    return LayoutService.instance;
  }

  /**
   * Get current layout mode
   */
  public getCurrentMode(): LayoutMode {
    return this.currentMode;
  }

  /**
   * Set layout mode
   * - Updates storage
   * - Applies CSS class
   * - Emits event
   * - Handles window resize for phone
   */
  public async setMode(mode: LayoutMode): Promise<void> {
    const previousMode = this.currentMode;
    this.currentMode = mode;
    this.storage.setLayoutMode(mode);
    this.applyLayoutClass();

    // Handle window resize for phone mode
    if (PlatformService.getInstance().isTauri) {
      await this.handleWindowResize(previousMode, mode);
    }

    // Emit event for components that need to react
    this.eventBus.emit('layout:changed', { mode, previousMode });

    // Also emit legacy event for backward compatibility during migration
    this.eventBus.emit('settings:layout-mode-changed', { mode });
  }

  /**
   * Refresh mode from storage (e.g., after account switch)
   */
  public refresh(): void {
    this.currentMode = this.storage.getLayoutMode();
    this.applyLayoutClass();
  }

  /**
   * Check if current mode is phone
   */
  public isPhone(): boolean {
    return this.currentMode === 'phone';
  }

  /**
   * Check if current mode is wide
   */
  public isWide(): boolean {
    return this.currentMode === 'wide';
  }

  /**
   * Check if current mode is right-pane
   */
  public isRightPane(): boolean {
    return this.currentMode === 'right-pane';
  }

  /**
   * Check if current mode is default
   */
  public isDefault(): boolean {
    return this.currentMode === 'default';
  }

  /**
   * Check if secondary content should be visible
   * (Hidden in 'wide' and 'phone' modes)
   */
  public isSecondaryVisible(): boolean {
    return this.currentMode !== 'wide' && this.currentMode !== 'phone';
  }

  /**
   * Check if sidebar should be visible
   * (Hidden in 'phone' mode)
   */
  public isSidebarVisible(): boolean {
    return this.currentMode !== 'phone';
  }

  /**
   * Apply CSS class to <html> element
   * Removes all layout classes, then adds current one
   */
  private applyLayoutClass(): void {
    const html = document.documentElement;
    const layoutClasses = ['layout--default', 'layout--right-pane', 'layout--wide', 'layout--phone'];

    // Remove all layout classes
    layoutClasses.forEach(cls => html.classList.remove(cls));

    // Add current layout class
    html.classList.add(`layout--${this.currentMode}`);
  }

  /**
   * Handle window resize when switching to/from phone mode
   */
  private async handleWindowResize(previousMode: LayoutMode, newMode: LayoutMode): Promise<void> {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const { LogicalSize } = await import('@tauri-apps/api/dpi');
      const currentWindow = getCurrentWindow();

      if (newMode === 'phone' && previousMode !== 'phone') {
        // Switching TO phone - save current width and resize
        const size = await currentWindow.innerSize();
        this.previousWindowWidth = size.width;

        await currentWindow.setSize(new LogicalSize(390, size.height));
      } else if (newMode !== 'phone' && previousMode === 'phone') {
        // Switching FROM phone - restore previous width
        const size = await currentWindow.innerSize();
        const restoreWidth = this.previousWindowWidth || 1200;

        await currentWindow.setSize(new LogicalSize(restoreWidth, size.height));

        this.previousWindowWidth = null;
      }
    } catch {
      // Silently fail if Tauri API not available (browser dev mode)
    }
  }
}
