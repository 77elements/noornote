/**
 * QRCodeModal - QR Code Display Modal
 * Shows QR code for npub (for easy profile sharing)
 * Uses ModalService for modal infrastructure
 */

import QRCode from 'qrcode';
import { ModalService } from '../../services/ModalService';

export class QRCodeModal {
  private static instance: QRCodeModal | null = null;
  private modalService: ModalService;

  private constructor() {
    this.modalService = ModalService.getInstance();
  }

  /**
   * Get singleton instance (create if needed)
   */
  public static getInstance(): QRCodeModal {
    if (!QRCodeModal.instance) {
      QRCodeModal.instance = new QRCodeModal();
    }
    return QRCodeModal.instance;
  }

  /**
   * Show modal with QR code for npub
   */
  public async show(npub: string): Promise<void> {
    // Show loading state first
    const loadingContent = this.renderLoadingContent();
    this.modalService.show({
      title: 'Profile QR Code',
      content: loadingContent,
      width: '400px',
      height: 'auto',
      maxWidth: '90%',
      maxHeight: '90%'
    });

    // Generate QR code
    try {
      const qrCodeDataUrl = await QRCode.toDataURL(npub, {
        width: 300,
        margin: 2,
        color: {
          dark: '#000000',
          light: '#FFFFFF'
        }
      });

      const qrContent = this.renderQRContent(npub, qrCodeDataUrl);

      // Update modal with QR code
      this.modalService.show({
        title: 'Profile QR Code',
        content: qrContent,
        width: '400px',
        height: 'auto',
        maxWidth: '90%',
        maxHeight: '90%'
      });
    } catch (error) {
      console.error('❌ Failed to generate QR code:', error);
      const errorContent = this.renderErrorContent('Failed to generate QR code');

      // Update modal with error
      this.modalService.show({
        title: 'Profile QR Code',
        content: errorContent,
        width: '400px',
        height: 'auto',
        maxWidth: '90%',
        maxHeight: '90%'
      });
    }
  }

  /**
   * Render loading content
   */
  private renderLoadingContent(): string {
    return `
      <div class="modal__loading">
        <div class="loading-spinner"></div>
        <p>Generating QR code...</p>
      </div>
    `;
  }

  /**
   * Render error content
   */
  private renderErrorContent(message: string): string {
    return `
      <div class="modal__error">
        <p>❌ ${this.escapeHtml(message)}</p>
      </div>
    `;
  }

  /**
   * Render QR code content
   */
  private renderQRContent(npub: string, qrCodeDataUrl: string): HTMLElement {
    // Shorten npub for display (first 12 + last 6 chars)
    const shortNpub = `${npub.slice(0, 12)}...${npub.slice(-6)}`;

    const container = document.createElement('div');
    container.className = 'qrcode-content';
    container.innerHTML = `
      <div class="qrcode-modal__qr-container">
        <img src="${qrCodeDataUrl}" alt="QR Code for ${this.escapeHtml(npub)}" class="qrcode-modal__qr-image" />
        <p class="qrcode-modal__npub-text">${this.escapeHtml(shortNpub)}</p>
        <p class="qrcode-modal__instruction">Scan for npub</p>
      </div>
    `;

    return container;
  }

  /**
   * Escape HTML to prevent XSS
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Cleanup and destroy modal
   */
  public destroy(): void {
    this.modalService.hide();
    QRCodeModal.instance = null;
  }
}
