/**
 * LayoutService - Central Layout Mode Management
 *
 * Single source of truth for layout state:
 * - Manages current layout mode ('default' | 'right-pane' | 'wide' | 'phone')
 * - Sets CSS class on <html> element for CSS-driven styling
 * - Emits 'layout:changed' event for reactive updates
 * - Handles Tauri window resize for phone mode
 *
 * Platform Priority:
 * - Desktop (≥1024px): User preference applies
 * - Tablet (768-1023px): Forces 'wide' mode
 * - Phone (<768px): Forces 'phone' mode
 *
 * @service LayoutService
 * @purpose Centralize layout mode logic, reduce scattered getLayoutMode() calls
 */

import { PerAccountLocalStorage, type LayoutMode } from './PerAccountLocalStorage';
import { EventBus } from './EventBus';
import { PlatformService } from './PlatformService';

type ScreenSize = 'desktop' | 'tablet' | 'phone';

export class LayoutService {
  private static instance: LayoutService;
  private storage: PerAccountLocalStorage;
  private eventBus: EventBus;
  private userPreference: LayoutMode = 'default';
  private effectiveMode: LayoutMode = 'default';
  private currentScreenSize: ScreenSize = 'desktop';
  private previousWindowWidth: number | null = null;
  private resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor() {
    this.storage = PerAccountLocalStorage.getInstance();
    this.eventBus = EventBus.getInstance();
    this.userPreference = this.storage.getLayoutMode();
    this.currentScreenSize = this.detectScreenSize();
    this.effectiveMode = this.calculateEffectiveMode();
    this.applyLayoutClass();
    this.setupResizeListener();
  }

  public static getInstance(): LayoutService {
    if (!LayoutService.instance) {
      LayoutService.instance = new LayoutService();
    }
    return LayoutService.instance;
  }

  /**
   * Get current effective layout mode (after platform priority applied)
   */
  public getCurrentMode(): LayoutMode {
    return this.effectiveMode;
  }

  /**
   * Get user's preferred mode (ignoring platform constraints)
   */
  public getUserPreference(): LayoutMode {
    return this.userPreference;
  }

  /**
   * Get current screen size category
   */
  public getScreenSize(): ScreenSize {
    return this.currentScreenSize;
  }

  /**
   * Check if user preference is being overridden by platform
   */
  public isForced(): boolean {
    return this.userPreference !== this.effectiveMode;
  }

  /**
   * Set user's preferred layout mode
   * - Updates storage
   * - Recalculates effective mode
   * - Applies CSS class
   * - Emits event
   * - Handles window resize for phone
   */
  public async setMode(mode: LayoutMode): Promise<void> {
    const previousMode = this.effectiveMode;
    this.userPreference = mode;
    this.storage.setLayoutMode(mode);

    // Recalculate effective mode based on platform
    this.effectiveMode = this.calculateEffectiveMode();
    this.applyLayoutClass();

    // Handle window resize for phone mode
    if (PlatformService.getInstance().isTauri) {
      await this.handleWindowResize(previousMode, this.effectiveMode);
    }

    // Emit event for components that need to react
    this.eventBus.emit('layout:changed', { mode: this.effectiveMode, previousMode });

    // Also emit legacy event for backward compatibility during migration
    this.eventBus.emit('settings:layout-mode-changed', { mode: this.effectiveMode });
  }

  /**
   * Refresh mode from storage (e.g., after account switch)
   */
  public refresh(): void {
    this.userPreference = this.storage.getLayoutMode();
    this.currentScreenSize = this.detectScreenSize();
    this.effectiveMode = this.calculateEffectiveMode();
    this.applyLayoutClass();
  }

  /**
   * Check if current mode is phone
   */
  public isPhone(): boolean {
    return this.effectiveMode === 'phone';
  }

  /**
   * Check if current mode is wide
   */
  public isWide(): boolean {
    return this.effectiveMode === 'wide';
  }

  /**
   * Check if current mode is right-pane
   */
  public isRightPane(): boolean {
    return this.effectiveMode === 'right-pane';
  }

  /**
   * Check if current mode is default
   */
  public isDefault(): boolean {
    return this.effectiveMode === 'default';
  }

  /**
   * Check if secondary content should be visible
   * (Hidden in 'wide' and 'phone' modes)
   */
  public isSecondaryVisible(): boolean {
    return this.effectiveMode !== 'wide' && this.effectiveMode !== 'phone';
  }

  /**
   * Check if sidebar should be visible
   * (Hidden in 'phone' mode)
   */
  public isSidebarVisible(): boolean {
    return this.effectiveMode !== 'phone';
  }

  /**
   * Detect screen size from CSS pseudo-element
   * Reads html::after { content: 'desktop' | 'tablet' | 'phone' }
   */
  private detectScreenSize(): ScreenSize {
    try {
      const content = getComputedStyle(document.documentElement, '::after').content;
      // CSS content comes with quotes: '"desktop"' or "'desktop'"
      const size = content.replace(/['"]/g, '') as ScreenSize;
      if (size === 'desktop' || size === 'tablet' || size === 'phone') {
        return size;
      }
    } catch {
      // Fallback to desktop
    }
    return 'desktop';
  }

  /**
   * Calculate effective mode based on platform priority
   * - Desktop: User preference
   * - Tablet: Force wide
   * - Phone: Force phone
   */
  private calculateEffectiveMode(): LayoutMode {
    switch (this.currentScreenSize) {
      case 'phone':
        return 'phone';
      case 'tablet':
        return 'wide';
      case 'desktop':
      default:
        return this.userPreference;
    }
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
    html.classList.add(`layout--${this.effectiveMode}`);
  }

  /**
   * Setup window resize listener for responsive platform detection
   */
  private setupResizeListener(): void {
    window.addEventListener('resize', () => {
      // Debounce resize events
      if (this.resizeDebounceTimer) {
        clearTimeout(this.resizeDebounceTimer);
      }
      this.resizeDebounceTimer = setTimeout(() => {
        this.handleScreenSizeChange();
      }, 150);
    });
  }

  /**
   * Handle screen size change (e.g., window resize)
   */
  private async handleScreenSizeChange(): Promise<void> {
    const newScreenSize = this.detectScreenSize();
    if (newScreenSize === this.currentScreenSize) return;

    const previousMode = this.effectiveMode;
    this.currentScreenSize = newScreenSize;
    this.effectiveMode = this.calculateEffectiveMode();

    if (this.effectiveMode !== previousMode) {
      this.applyLayoutClass();

      // Emit event for components that need to react
      this.eventBus.emit('layout:changed', {
        mode: this.effectiveMode,
        previousMode,
        screenSize: this.currentScreenSize,
        forced: this.isForced()
      });
    }
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
