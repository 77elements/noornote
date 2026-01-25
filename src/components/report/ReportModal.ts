/**
 * ReportModal - NIP-56 Report UI Component
 * Modal for reporting notes/users with various report types
 * Uses ModalService for modal infrastructure
 */

import { ModalService } from '../../services/ModalService';
import { ReportService, type ReportType } from '../../services/ReportService';
import { UserProfileService } from '../../services/UserProfileService';
import { AuthGuard } from '../../services/AuthGuard';
import { ToastService } from '../../services/ToastService';
import { escapeHtml } from '../../helpers/escapeHtml';
import { SystemLogger } from '../system/SystemLogger';

export interface ReportModalOptions {
  /** User pubkey being reported */
  reportedPubkey: string;
  /** Optional: Specific event ID being reported */
  reportedEventId?: string;
}

export class ReportModal {
  private static instance: ReportModal | null = null;
  private modalService: ModalService;
  private reportService: ReportService;
  private userProfileService: UserProfileService;
  private systemLogger: SystemLogger;
  private currentOptions: ReportModalOptions | null = null;

  private constructor() {
    this.modalService = ModalService.getInstance();
    this.reportService = ReportService.getInstance();
    this.userProfileService = UserProfileService.getInstance();
    this.systemLogger = SystemLogger.getInstance();
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): ReportModal {
    if (!ReportModal.instance) {
      ReportModal.instance = new ReportModal();
    }
    return ReportModal.instance;
  }

  /**
   * Show report modal
   */
  public show(options: ReportModalOptions): void {
    // Check authentication for reporting (Write Event)
    if (!AuthGuard.requireAuth('report this content')) {
      return;
    }

    this.currentOptions = options;
    const content = this.renderContent(options);

    this.modalService.show({
      title: 'Report Content',
      content,
      width: '500px',
      showCloseButton: true,
      closeOnOverlay: true,
      closeOnEsc: true
    });

    // Setup event handlers after modal is shown
    setTimeout(() => {
      this.setupEventHandlers();
    }, 0);
  }

  /**
   * Render modal content
   */
  private renderContent(options: ReportModalOptions): HTMLElement {
    const username = this.userProfileService.getUsername(options.reportedPubkey) ?? 'Unknown';
    const reportTypes = ReportService.getReportTypes();

    const container = document.createElement('div');
    container.className = 'report-modal';

    // Report info
    const reportInfoHtml = options.reportedEventId
      ? `<p class="report-modal__info">You are reporting a specific note by <strong>${escapeHtml(username)}</strong>.</p>`
      : `<p class="report-modal__info">You are reporting user <strong>${escapeHtml(username)}</strong>.</p>`;

    // Report types list
    const reportTypesHtml = reportTypes
      .map((type) => {
        const label = ReportService.getReportTypeLabel(type);
        const description = ReportService.getReportTypeDescription(type);

        return `
        <label class="report-modal__option">
          <input type="radio" name="report-type" value="${type}" class="report-modal__radio" />
          <div class="report-modal__option-content">
            <div class="report-modal__option-label">${escapeHtml(label)}</div>
            <div class="report-modal__option-description">${escapeHtml(description)}</div>
          </div>
        </label>
      `;
      })
      .join('');

    container.innerHTML = `
      ${reportInfoHtml}

      <div class="report-modal__section">
        <h3 class="report-modal__section-title">Select report reason</h3>
        <div class="report-modal__options">
          ${reportTypesHtml}
        </div>
      </div>

      <div class="report-modal__section">
        <h3 class="report-modal__section-title">Additional details (optional)</h3>
        <textarea
          class="textarea report-modal__textarea"
          placeholder="Provide additional context for your report..."
          maxlength="500"
          rows="4"
        ></textarea>
        <div class="report-modal__char-count">
          <span class="report-modal__char-current">0</span> / 500
        </div>
      </div>

      <div class="report-modal__actions">
        <button class="btn btn--cancel" type="button">Cancel</button>
        <button class="btn btn--danger btn--submit" type="button" disabled>Submit Report</button>
      </div>

      <div class="report-modal__notice">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/>
          <path d="M8 4v5M8 11v1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <p>Reports are published as NIP-56 events to your relays. They may be used by clients and relay operators for content moderation.</p>
      </div>
    `;

    return container;
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers(): void {
    const modal = document.querySelector('.report-modal');
    if (!modal) return;

    const submitBtn = modal.querySelector('.btn--submit') as HTMLButtonElement;
    const cancelBtn = modal.querySelector('.btn--cancel') as HTMLButtonElement;
    const radioButtons = modal.querySelectorAll('input[name="report-type"]') as NodeListOf<HTMLInputElement>;
    const textarea = modal.querySelector('.report-modal__textarea') as HTMLTextAreaElement;
    const charCurrent = modal.querySelector('.report-modal__char-current') as HTMLSpanElement;

    // Enable submit button when report type is selected
    radioButtons.forEach((radio) => {
      radio.addEventListener('change', () => {
        if (submitBtn) {
          submitBtn.disabled = false;
        }
      });
    });

    // Update character count
    if (textarea && charCurrent) {
      textarea.addEventListener('input', () => {
        charCurrent.textContent = textarea.value.length.toString();
      });
    }

    // Cancel button
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        this.modalService.hide();
      });
    }

    // Submit button
    if (submitBtn) {
      submitBtn.addEventListener('click', () => {
        this.handleSubmit(modal);
      });
    }
  }

  /**
   * Handle report submission
   */
  private async handleSubmit(modal: Element): Promise<void> {
    if (!this.currentOptions) return;

    const selectedRadio = modal.querySelector('input[name="report-type"]:checked') as HTMLInputElement;
    if (!selectedRadio) {
      ToastService.show('Please select a report reason', 'error');
      return;
    }

    const reportType = selectedRadio.value as ReportType;
    const textarea = modal.querySelector('.report-modal__textarea') as HTMLTextAreaElement;
    const reason = textarea?.value.trim();

    const submitBtn = modal.querySelector('.btn--submit') as HTMLButtonElement;

    // Disable button and show loading state
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting...';
    }

    try {
      const reportOptions: Parameters<typeof this.reportService.createReport>[0] = {
        type: reportType,
        reportedPubkey: this.currentOptions.reportedPubkey
      };
      if (reason) {
        reportOptions.reason = reason;
      }
      if (this.currentOptions.reportedEventId) {
        reportOptions.reportedEventId = this.currentOptions.reportedEventId;
      }
      const result = await this.reportService.createReport(reportOptions);

      if (result.success) {
        this.systemLogger.info('ReportModal', 'Report submitted successfully');
        this.modalService.hide();
      } else {
        this.systemLogger.error('ReportModal', 'Report submission failed');

        // Re-enable button
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Submit Report';
        }
      }
    } catch (error) {
      this.systemLogger.error('ReportModal', `Report submission error: ${error}`);

      // Re-enable button
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Report';
      }
    }
  }

  /**
   * Cleanup and destroy modal
   */
  public destroy(): void {
    this.modalService.hide();
    this.currentOptions = null;
    ReportModal.instance = null;
  }
}
