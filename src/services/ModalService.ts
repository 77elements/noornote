/**
 * ModalService - Centralized Modal Management
 * Single service for all modal windows in the app
 * Handles overlay, ESC key, close button, and cleanup
 */

import { escapeHtml } from '../helpers/escapeHtml';

export interface ModalConfig {
  title: string;
  content: HTMLElement | string;
  width?: string;              // default: '50%'
  height?: string;             // default: '50%'
  showCloseButton?: boolean;   // default: true
  closeOnOverlay?: boolean;    // default: true
  closeOnEsc?: boolean;        // default: true
  onClose?: () => void;
}

export interface ConfirmConfig {
  title: string;
  message: string;
  confirmText?: string;        // default: 'Confirm'
  cancelText?: string;         // default: 'Cancel'
  confirmDestructive?: boolean; // default: false - if true, confirm button styled as destructive
}

export interface PromptConfig {
  title: string;
  message: string;
  placeholder?: string;
  defaultValue?: string;
  confirmText?: string;        // default: 'OK'
  cancelText?: string;         // default: 'Cancel'
  allowEmpty?: boolean;        // default: false. When true, confirming with an empty input resolves '' instead of null (lets callers distinguish "clear" from "cancel").
  multiline?: boolean;         // default: false. When true, renders a <textarea> instead of a single-line input (Enter inserts a newline, does not submit).
}

export class ModalService {
  private static instance: ModalService | null = null;
  private container: HTMLElement | null = null;
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null;
  private isVisible: boolean = false;
  private currentConfig: ModalConfig | null = null;

  private constructor() {
    // Private constructor for singleton
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): ModalService {
    if (!ModalService.instance) {
      ModalService.instance = new ModalService();
    }
    return ModalService.instance;
  }

  /**
   * Show modal with config
   */
  public show(config: ModalConfig): void {
    // Hide existing modal if open
    if (this.isVisible) {
      this.hide();
    }

    this.currentConfig = config;
    this.isVisible = true;

    // Create modal container if needed
    if (!this.container) {
      this.container = document.createElement('div');
      this.container.className = 'modal';
      document.body.appendChild(this.container);
    }

    const width = config.width || '50%';
    const height = config.height || '50%';
    const showCloseButton = config.showCloseButton !== false;
    const closeOnOverlay = config.closeOnOverlay !== false;
    const closeOnEsc = config.closeOnEsc !== false;

    // Build close button HTML
    const closeButtonHtml = showCloseButton
      ? '<button class="modal__close" title="Close (ESC)">×</button>'
      : '';

    // Render modal structure
    this.container.innerHTML = `
      <div class="modal__overlay"></div>
      <div class="modal__content" style="max-width: ${escapeHtml(width)}; max-height: ${escapeHtml(height)};">
        <div class="modal__header">
          <h1>${escapeHtml(config.title)}</h1>
          ${closeButtonHtml}
        </div>
        <div class="modal__body"></div>
      </div>
    `;

    // Insert content (preserve event listeners if HTMLElement)
    const bodyElement = this.container.querySelector('.modal__body');
    if (bodyElement) {
      if (typeof config.content === 'string') {
        bodyElement.innerHTML = config.content;
      } else {
        // Append actual element to preserve event listeners
        bodyElement.appendChild(config.content);
      }
    }

    // Show modal
    this.container.style.display = 'flex';

    // Setup event handlers
    this.setupEventHandlers(showCloseButton, closeOnOverlay, closeOnEsc);
  }

  /**
   * Hide modal
   */
  public hide(): void {
    if (!this.isVisible || !this.container) return;

    this.isVisible = false;
    this.container.style.display = 'none';
    this.container.innerHTML = '';

    // Remove ESC handler
    if (this.escapeHandler) {
      document.removeEventListener('keydown', this.escapeHandler);
      this.escapeHandler = null;
    }

    // Call onClose callback
    if (this.currentConfig?.onClose) {
      this.currentConfig.onClose();
    }

    this.currentConfig = null;
  }

  /**
   * Check if modal is currently visible
   */
  public isOpen(): boolean {
    return this.isVisible;
  }

  /**
   * Show a confirmation dialog and return a promise that resolves to true/false
   */
  public confirm(config: ConfirmConfig): Promise<boolean> {
    return new Promise((resolve) => {
      const confirmText = config.confirmText || 'Confirm';
      const cancelText = config.cancelText || 'Cancel';
      const confirmClass = config.confirmDestructive ? 'btn-danger' : 'btn-primary';

      const content = document.createElement('div');
      content.className = 'modal-confirm';
      content.innerHTML = `
        <p class="modal-confirm__message">${escapeHtml(config.message)}</p>
        <div class="l-row l-row--center">
          <button class="btn btn--passive modal-confirm__cancel">${escapeHtml(cancelText)}</button>
          <button class="btn ${confirmClass} modal-confirm__confirm">${escapeHtml(confirmText)}</button>
        </div>
      `;

      const cancelBtn = content.querySelector('.modal-confirm__cancel');
      const confirmBtn = content.querySelector('.modal-confirm__confirm');

      let settled = false;
      const settle = (value: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      cancelBtn?.addEventListener('click', () => {
        settle(false);
        this.hide();
      });

      confirmBtn?.addEventListener('click', () => {
        settle(true);
        this.hide();
      });

      this.show({
        title: config.title,
        content,
        width: '400px',
        height: 'auto',
        showCloseButton: true,
        closeOnOverlay: true,
        closeOnEsc: true,
        onClose: () => settle(false),
      });
    });
  }

  /**
   * Show a single-line text-input prompt and resolve with the entered value
   * (trimmed) or null if cancelled. Submits on Enter; cancels on Escape /
   * overlay click. Modal-helper replacement for `window.prompt()`.
   */
  public prompt(config: PromptConfig): Promise<string | null> {
    return new Promise((resolve) => {
      const confirmText = config.confirmText || 'OK';
      const cancelText = config.cancelText || 'Cancel';

      const content = document.createElement('div');
      content.className = 'modal-prompt';
      const field = config.multiline
        ? `<textarea class="textarea modal-prompt__input" placeholder="${escapeHtml(config.placeholder ?? '')}">${escapeHtml(config.defaultValue ?? '')}</textarea>`
        : `<input type="text" class="modal-prompt__input" placeholder="${escapeHtml(config.placeholder ?? '')}" value="${escapeHtml(config.defaultValue ?? '')}" />`;

      content.innerHTML = `
        <p class="modal-prompt__message">${escapeHtml(config.message)}</p>
        <div class="form__row">
          ${field}
        </div>
        <div class="l-row l-row--center">
          <button class="btn btn--passive modal-prompt__cancel">${escapeHtml(cancelText)}</button>
          <button class="btn btn-primary modal-prompt__confirm">${escapeHtml(confirmText)}</button>
        </div>
      `;

      const input = content.querySelector('.modal-prompt__input') as HTMLInputElement | HTMLTextAreaElement | null;
      const cancelBtn = content.querySelector('.modal-prompt__cancel');
      const confirmBtn = content.querySelector('.modal-prompt__confirm');

      let settled = false;
      const settle = (value: string | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const submit = (): void => {
        const v = input?.value?.trim() ?? '';
        settle(v.length > 0 || config.allowEmpty ? v : null);
        this.hide();
      };

      cancelBtn?.addEventListener('click', () => {
        settle(null);
        this.hide();
      });
      confirmBtn?.addEventListener('click', submit);
      // Single-line: Enter submits. Multiline textarea: Enter inserts a newline.
      if (!config.multiline) {
        input?.addEventListener('keydown', (e) => {
          if ((e as KeyboardEvent).key === 'Enter') {
            e.preventDefault();
            submit();
          }
        });
      }

      this.show({
        title: config.title,
        content,
        width: '400px',
        height: 'auto',
        showCloseButton: true,
        closeOnOverlay: true,
        closeOnEsc: true,
        onClose: () => settle(null),
      });

      // Focus the input after the modal mounts.
      setTimeout(() => input?.focus(), 0);
    });
  }

  /**
   * Setup event handlers for close actions
   */
  private setupEventHandlers(
    showCloseButton: boolean,
    closeOnOverlay: boolean,
    closeOnEsc: boolean
  ): void {
    if (!this.container) return;

    // Close button handler
    if (showCloseButton) {
      const closeBtn = this.container.querySelector('.modal__close');
      closeBtn?.addEventListener('click', () => this.hide());
    }

    // Overlay click handler
    if (closeOnOverlay) {
      const overlay = this.container.querySelector('.modal__overlay');
      overlay?.addEventListener('click', () => this.hide());
    }

    // ESC key handler
    if (closeOnEsc) {
      this.escapeHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          this.hide();
        }
      };
      document.addEventListener('keydown', this.escapeHandler);
    }
  }


  /**
   * Destroy modal service (cleanup)
   */
  public destroy(): void {
    this.hide();
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
    ModalService.instance = null;
  }
}
