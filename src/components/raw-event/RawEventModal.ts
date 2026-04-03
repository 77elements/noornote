/**
 * RawEventModal - Display Raw Nostr Event JSON
 * Shows full event JSON with copy functionality
 * Uses ModalService for modal infrastructure
 */

import type { NostrEvent } from '@nostr-dev-kit/ndk';
import { ModalService } from '../../services/ModalService';
import { escapeHtml } from '../../helpers/escapeHtml';

export class RawEventModal {
  private static instance: RawEventModal | null = null;
  private modalService: ModalService;

  private constructor() {
    this.modalService = ModalService.getInstance();
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): RawEventModal {
    if (!RawEventModal.instance) {
      RawEventModal.instance = new RawEventModal();
    }
    return RawEventModal.instance;
  }

  /**
   * Show modal with raw event JSON
   */
  public show(event: NostrEvent): void {
    const content = this.renderContent(event);

    this.modalService.show({
      title: 'Raw Event',
      content,
      width: '800px',
      height: '80vh',
      showCloseButton: true,
      closeOnOverlay: true,
      closeOnEsc: true
    });

    // Setup copy button handler after modal is shown
    setTimeout(() => {
      this.setupCopyButton(event);
    }, 0);
  }

  /**
   * Render modal content
   */
  private renderContent(event: NostrEvent): HTMLElement {
    const jsonString = JSON.stringify(event, null, 2);

    const container = document.createElement('div');
    container.className = 'raw-event-modal';
    container.innerHTML = `
      <div class="raw-event-modal__actions">
        <button class="btn btn--copy-json" type="button">
          <svg width="16" height="16"><use href="#icon-copy"/></svg>
          Copy JSON
        </button>
      </div>
      <pre class="raw-event-modal__code"><code>${escapeHtml(jsonString)}</code></pre>
    `;

    return container;
  }

  /**
   * Setup copy button functionality
   */
  private setupCopyButton(event: NostrEvent): void {
    const copyBtn = document.querySelector('.btn--copy-json');
    if (!copyBtn) return;

    const jsonString = JSON.stringify(event, null, 2);

    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(jsonString);
        copyBtn.innerHTML = `
          <svg width="16" height="16"><use href="#icon-checkmark"/></svg>
          Copied!
        `;

        setTimeout(() => {
          copyBtn.innerHTML = `
            <svg width="16" height="16"><use href="#icon-copy"/></svg>
            Copy JSON
          `;
        }, 2000);
      } catch (error) {
        console.error('Failed to copy JSON:', error);
      }
    });
  }

  /**
   * Cleanup and destroy modal
   */
  public destroy(): void {
    this.modalService.hide();
    RawEventModal.instance = null;
  }
}
