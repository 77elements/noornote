/**
 * DateRangeSelector
 * Builds modal content for selecting a date range (from/to) for timeline filtering.
 * Returns Unix timestamps for the selected range.
 */

import { ModalService } from '../../../services/ModalService';

export interface DateRangeResult {
  since: number; // Unix timestamp, start of from-day (00:00:00)
  until: number; // Unix timestamp, end of to-day (23:59:59)
}

export class DateRangeSelector {
  private modalService: ModalService;

  constructor() {
    this.modalService = ModalService.getInstance();
  }

  /**
   * Show the date range picker modal.
   * Resolves with the selected range, or null if cancelled.
   */
  public show(): Promise<DateRangeResult | null> {
    return new Promise((resolve) => {
      let resolved = false;

      const container = document.createElement('div');
      container.className = 'date-range-selector';

      // Defaults: from = 3 days ago, to = today
      const today = new Date();
      const threeDaysAgo = new Date();
      threeDaysAgo.setDate(today.getDate() - 3);

      const todayStr = this.formatDateForInput(today);
      const fromStr = this.formatDateForInput(threeDaysAgo);

      container.innerHTML = `
        <div class="date-range-selector__fields">
          <label class="date-range-selector__field">
            <span class="date-range-selector__label">From</span>
            <input type="date" class="datepicker" id="date-range-from" value="${fromStr}" max="${todayStr}" />
          </label>
          <label class="date-range-selector__field">
            <span class="date-range-selector__label">To</span>
            <input type="date" class="datepicker" id="date-range-to" value="${todayStr}" max="${todayStr}" />
          </label>
        </div>
        <div class="date-range-selector__error" id="date-range-error" style="display: none;"></div>
        <div class="date-range-selector__actions">
          <button class="btn btn--secondary" id="date-range-cancel">Cancel</button>
          <button class="btn" id="date-range-confirm">Show Notes</button>
        </div>
      `;

      this.modalService.show({
        title: 'Select Time Range',
        content: container,
        width: '380px',
        height: 'auto',
        showCloseButton: true,
        closeOnOverlay: true,
        closeOnEsc: true,
        onClose: () => {
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        }
      });

      // Setup handlers after modal is in DOM
      setTimeout(() => {
        const fromInput = document.getElementById('date-range-from') as HTMLInputElement;
        const toInput = document.getElementById('date-range-to') as HTMLInputElement;
        const errorEl = document.getElementById('date-range-error') as HTMLElement;
        const cancelBtn = document.getElementById('date-range-cancel');
        const confirmBtn = document.getElementById('date-range-confirm');

        cancelBtn?.addEventListener('click', () => {
          resolved = true;
          this.modalService.hide();
          resolve(null);
        });

        confirmBtn?.addEventListener('click', () => {
          const result = this.validate(fromInput, toInput, errorEl);
          if (result) {
            resolved = true;
            this.modalService.hide();
            resolve(result);
          }
        });

        // Enter key confirms
        const handleEnter = (e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            confirmBtn?.click();
          }
        };
        fromInput?.addEventListener('keydown', handleEnter);
        toInput?.addEventListener('keydown', handleEnter);
      }, 0);
    });
  }

  /**
   * Validate inputs and return result or show error
   */
  private validate(
    fromInput: HTMLInputElement,
    toInput: HTMLInputElement,
    errorEl: HTMLElement
  ): DateRangeResult | null {
    const fromVal = fromInput?.value;
    const toVal = toInput?.value;

    if (!fromVal || !toVal) {
      this.showError(errorEl, 'Please select both dates.');
      return null;
    }

    const fromDate = new Date(fromVal + 'T00:00:00');
    const toDate = new Date(toVal + 'T23:59:59');
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    if (fromDate > toDate) {
      this.showError(errorEl, '"From" date must be before "To" date.');
      return null;
    }

    if (toDate > todayEnd) {
      this.showError(errorEl, '"To" date cannot be in the future.');
      return null;
    }

    errorEl.style.display = 'none';

    return {
      since: Math.floor(fromDate.getTime() / 1000),
      until: Math.floor(toDate.getTime() / 1000)
    };
  }

  private showError(el: HTMLElement, msg: string): void {
    el.textContent = msg;
    el.style.display = 'block';
  }

  /**
   * Format a date range for display in the dropdown label
   */
  public static formatRangeLabel(since: number, until: number): string {
    const from = new Date(since * 1000);
    const to = new Date(until * 1000);
    const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
    const fromStr = from.toLocaleDateString('en-US', opts);
    const toStr = to.toLocaleDateString('en-US', opts);
    return fromStr === toStr ? fromStr : `${fromStr} – ${toStr}`;
  }

  private formatDateForInput(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
}
