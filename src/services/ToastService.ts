/**
 * ToastService - User Notification System
 * Shows temporary toast notifications for user feedback.
 *
 * Usage:
 *   ToastService.show('Note posted!', 'success');
 *   ToastService.show('Failed to load', 'error');
 *   const id = ToastService.loading('Waiting for signer approval…');  // persistent spinner
 *   ToastService.dismiss(id);
 *   ToastService.showWithAction('Failed to post', 'error', { label: 'Open drafts', onClick });
 */

import { escapeHtml } from '../helpers/escapeHtml';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  message: string;
  type: ToastType;
  /** milliseconds, default 4000 (ignored when loading/persistent) */
  duration?: number;
  /** Spinner + pulsating message; stays until dismissed. */
  loading?: boolean;
  /** No auto-dismiss (implied by loading). */
  persistent?: boolean;
  /** Inline action button (e.g. "Open drafts"). */
  action?: ToastAction;
}

export class ToastService {
  private static instance: ToastService;
  private container: HTMLElement | null = null;
  private activeToasts: Map<string, HTMLElement> = new Map();
  private counter = 0;

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
   * Show a basic toast notification
   */
  public static show(message: string, type: ToastType = 'info', duration: number = 4000): void {
    ToastService.getInstance().showToast({ message, type, duration });
  }

  /**
   * Show a toast with an inline action button. Returns its id.
   */
  public static showWithAction(
    message: string,
    type: ToastType,
    action: ToastAction,
    duration: number = 10000
  ): string {
    return ToastService.getInstance().showToast({ message, type, action, duration });
  }

  /**
   * Show a persistent loading toast (spinner + pulsating text). Returns its id;
   * dismiss it via ToastService.dismiss(id) once the async work settles.
   */
  public static loading(message: string): string {
    return ToastService.getInstance().showToast({
      message,
      type: 'info',
      loading: true,
      persistent: true,
    });
  }

  /**
   * Dismiss a specific toast by id
   */
  public static dismiss(id: string): void {
    ToastService.getInstance().hideToast(id);
  }

  /**
   * Clear all active toasts
   */
  public static clear(): void {
    ToastService.getInstance().clearAll();
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
   * Show individual toast, returns its id
   */
  private showToast(options: ToastOptions): string {
    if (!this.container) return '';

    const toastId = `toast-${++this.counter}`;
    const toast = this.createToastElement(options, toastId);

    this.activeToasts.set(toastId, toast);
    this.container.appendChild(toast);

    // Trigger animation after DOM insertion
    setTimeout(() => {
      toast.classList.add('toast--visible');
    }, 10);

    // Auto-remove after duration (unless loading/persistent)
    if (!options.loading && !options.persistent) {
      setTimeout(() => {
        this.hideToast(toastId);
      }, options.duration || 4000);
    }

    return toastId;
  }

  /**
   * Create toast DOM element
   */
  private createToastElement(options: ToastOptions, toastId: string): HTMLElement {
    const toast = document.createElement('div');
    toast.className = `toast toast--${options.type}${options.loading ? ' toast--loading' : ''}`;

    const iconHtml = options.loading
      ? `<svg class="toast__spinner pulsate" width="18" height="18"><use href="#icon-spinner"/></svg>`
      : this.getIcon(options.type);

    const messageClass = options.loading ? 'toast__message pulsate' : 'toast__message';

    const actionHtml = options.action
      ? `<button class="btn btn--passive btn--mini toast__action">${escapeHtml(options.action.label)}</button>`
      : '';

    toast.innerHTML = `
      <div class="toast__icon">${iconHtml}</div>
      <div class="${messageClass}">${escapeHtml(options.message)}</div>
      ${actionHtml}
      <button class="toast__close" aria-label="Close">×</button>
    `;

    // Action button handler
    if (options.action) {
      toast.querySelector('.toast__action')?.addEventListener('click', () => {
        options.action!.onClick();
        this.hideToast(toastId);
      });
    }

    // Close button handler
    toast.querySelector('.toast__close')?.addEventListener('click', () => {
      this.hideToast(toastId);
    });

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
