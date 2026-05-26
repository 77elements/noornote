/**
 * OfflineOverlay - Fullscreen Offline State Display
 * Shows when no internet connection is detected
 *
 * @purpose Block app usage and show clear message when offline
 * @architecture Singleton component, controlled by App.ts and ConnectivityService
 */

import { TypedEventBus } from '../../core/TypedEventBus';
import { ConnectivityService } from '../../services/ConnectivityService';

export class OfflineOverlay {
  private static instance: OfflineOverlay;
  private element: HTMLElement;
  private eventBus: TypedEventBus;
  private connectivityService: ConnectivityService;
  private isVisible: boolean = false;
  private retryInProgress: boolean = false;

  private constructor() {
    this.eventBus = TypedEventBus.getInstance();
    this.connectivityService = ConnectivityService.getInstance();
    this.element = this.createElement();
    this.setupEventListeners();
  }

  public static getInstance(): OfflineOverlay {
    if (!OfflineOverlay.instance) {
      OfflineOverlay.instance = new OfflineOverlay();
    }
    return OfflineOverlay.instance;
  }

  /**
   * Create the overlay DOM element
   */
  private createElement(): HTMLElement {
    const overlay = document.createElement('div');
    overlay.className = 'offline-overlay';
    overlay.innerHTML = `
      <div class="offline-overlay__content">
        <div class="offline-overlay__icon">
          <svg width="64" height="64"><use href="#icon-wifi-off"/></svg>
        </div>
        <h2 class="offline-overlay__title">No Internet Connection</h2>
        <p class="offline-overlay__message">Please check your network connection and try again.</p>
        <button class="offline-overlay__retry btn btn-primary">
          <span class="offline-overlay__retry-text">Retry</span>
          <span class="offline-overlay__retry-spinner"></span>
        </button>
      </div>
    `;

    // Retry button handler
    const retryBtn = overlay.querySelector('.offline-overlay__retry');
    retryBtn?.addEventListener('click', () => this.handleRetry());

    return overlay;
  }

  /**
   * Setup event listeners for connectivity changes
   */
  private setupEventListeners(): void {
    // Hide overlay and reload when back online
    this.eventBus.on('connectivity:status', (data: { online: boolean }) => {
      if (data.online && this.isVisible) {
        this.hide();
        window.location.reload();
      }
    });

    // Show overlay after prolonged offline (120s)
    this.eventBus.on('connectivity:prolonged-offline', () => {
      this.show();
    });
  }

  /**
   * Handle retry button click
   */
  private async handleRetry(): Promise<void> {
    if (this.retryInProgress) return;

    this.retryInProgress = true;
    this.element.classList.add('offline-overlay--retrying');

    const isOnline = await this.connectivityService.checkConnectivity();

    this.retryInProgress = false;
    this.element.classList.remove('offline-overlay--retrying');

    if (isOnline) {
      this.hide();
      window.location.reload();
    }
  }

  /**
   * Show the overlay
   */
  public show(): void {
    if (this.isVisible) return;

    document.body.appendChild(this.element);
    // Trigger animation
    requestAnimationFrame(() => {
      this.element.classList.add('offline-overlay--visible');
    });
    this.isVisible = true;
  }

  /**
   * Hide the overlay
   */
  public hide(): void {
    if (!this.isVisible) return;

    this.element.classList.remove('offline-overlay--visible');
    setTimeout(() => {
      this.element.remove();
    }, 300);
    this.isVisible = false;
  }

  /**
   * Check if overlay is currently visible
   */
  public isShowing(): boolean {
    return this.isVisible;
  }
}
