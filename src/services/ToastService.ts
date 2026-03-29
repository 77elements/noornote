/**
 * ToastService - User Notification System
 * Shows temporary toast notifications for user feedback
 *
 * Usage:
 * ToastService.show('Note posted!', 'success');
 * ToastService.show('Failed to load', 'error');
 */

import { escapeHtml } from '../helpers/escapeHtml';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastOptions {
  message: string;
  type: ToastType;
  duration?: number; // milliseconds, default 4000
}

export class ToastService {
  private static instance: ToastService;
  private container: HTMLElement | null = null;
  private activeToasts: Map<string, HTMLElement> = new Map();

  private constructor() {
    this.createContainer();
  }

  public static getInstance(): ToastService {
    if (!ToastService.instance) {
      ToastService.instance = new ToastService();
    }
    return ToastService.instance;
  }

  /**
   * Show a toast notification
   */
  public static show(message: string, type: ToastType = 'info', duration: number = 4000): void {
    const instance = ToastService.getInstance();
    instance.showToast({ message, type, duration });
  }

  /**
   * Clear all active toasts
   */
  public static clear(): void {
    const instance = ToastService.getInstance();
    instance.clearAll();
  }

  /**
   * Create toast container (mounted in body)
   */
  private createContainer(): void {
    if (this.container) return;

    this.container = document.createElement('div');
    this.container.className = 'toast-container';
    document.body.appendChild(this.container);
  }

  /**
   * Show individual toast
   */
  private showToast(options: ToastOptions): void {
    if (!this.container) return;

    const toastId = `toast-${Date.now()}-${Math.random()}`;
    const toast = this.createToastElement(options);

    this.activeToasts.set(toastId, toast);
    this.container.appendChild(toast);

    // Trigger animation after DOM insertion
    setTimeout(() => {
      toast.classList.add('toast--visible');
    }, 10);

    // Auto-remove after duration
    setTimeout(() => {
      this.hideToast(toastId);
    }, options.duration || 4000);
  }

  /**
   * Create toast DOM element
   */
  private createToastElement(options: ToastOptions): HTMLElement {
    const toast = document.createElement('div');
    toast.className = `toast toast--${options.type}`;

    const icon = this.getIcon(options.type);

    toast.innerHTML = `
      <div class="toast__icon">${icon}</div>
      <div class="toast__message">${escapeHtml(options.message)}</div>
      <button class="toast__close" aria-label="Close">×</button>
    `;

    // Close button handler
    const closeBtn = toast.querySelector('.toast__close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        const toastId = Array.from(this.activeToasts.entries())
          .find(([_id, el]) => el === toast)?.[0];
        if (toastId) {
          this.hideToast(toastId);
        }
      });
    }

    return toast;
  }

  /**
   * Hide and remove toast
   */
  private hideToast(toastId: string): void {
    const toast = this.activeToasts.get(toastId);
    if (!toast) return;

    toast.classList.remove('toast--visible');
    toast.classList.add('toast--hiding');

    setTimeout(() => {
      toast.remove();
      this.activeToasts.delete(toastId);
    }, 300); // Match CSS transition duration
  }

  /**
   * Clear all toasts
   */
  private clearAll(): void {
    this.activeToasts.forEach((_toast, id) => {
      this.hideToast(id);
    });
  }

  /**
   * Get icon for toast type
   */
  private getIcon(type: ToastType): string {
    switch (type) {
      case 'success':
        return '✓';
      case 'error':
        return '✕';
      case 'warning':
        return '⚠';
      case 'info':
      default:
        return 'ℹ';
    }
  }

}
