/**
 * Modal-based date pickers.
 *
 * Two flavors:
 *   - `pickDate()`     — single date (e.g. NIP-23 `published_at` backdating)
 *   - `pickDateRange()` — from/to range (e.g. timeline "Select Time Range")
 *
 * Both return `null` on cancel. Promises resolve after the modal closes.
 */

import { ModalService } from '../services/ModalService';

export interface DateRangeResult {
  since: number; // Unix timestamp, start of from-day (00:00:00)
  until: number; // Unix timestamp, end of to-day (23:59:59)
}

export interface PickDateOptions {
  title?: string;
  initial?: Date;
  /** Hard upper bound (inclusive). Omit to allow any future date. */
  max?: Date;
  confirmLabel?: string;
}

export interface PickDateRangeOptions {
  title?: string;
  initialFrom?: Date;
  initialTo?: Date;
  confirmLabel?: string;
}

function formatDateForInput(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Format a date range as a compact label (e.g. "Apr 5 – Apr 8, 2026").
 */
export function formatDateRangeLabel(since: number, until: number): string {
  const from = new Date(since * 1000);
  const to = new Date(until * 1000);
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
  const fromStr = from.toLocaleDateString('en-US', opts);
  const toStr = to.toLocaleDateString('en-US', opts);
  return fromStr === toStr ? fromStr : `${fromStr} – ${toStr}`;
}

/**
 * Show a modal to pick a single date. Resolves with the chosen date (at
 * 12:00 local time) or `null` if cancelled.
 */
export function pickDate(options: PickDateOptions = {}): Promise<Date | null> {
  const modalService = ModalService.getInstance();
  const title = options.title ?? 'Pick a date';
  const confirmLabel = options.confirmLabel ?? 'Confirm';
  const initial = options.initial ?? new Date();
  const maxAttr = options.max ? ` max="${formatDateForInput(options.max)}"` : '';

  return new Promise((resolve) => {
    let resolved = false;
    const container = document.createElement('div');
    container.className = 'date-range-selector';
    container.innerHTML = `
      <div class="date-range-selector__fields">
        <label class="date-range-selector__field">
          <span class="date-range-selector__label">Date</span>
          <input type="date" class="datepicker" data-pick-date value="${formatDateForInput(initial)}"${maxAttr} />
        </label>
      </div>
      <div class="date-range-selector__error" data-pick-error style="display: none;"></div>
      <div class="date-range-selector__actions">
        <button class="btn btn--secondary" data-pick-cancel>Cancel</button>
        <button class="btn" data-pick-confirm>${confirmLabel}</button>
      </div>
    `;

    modalService.show({
      title,
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

    setTimeout(() => {
      const input = container.querySelector('[data-pick-date]') as HTMLInputElement;
      const errorEl = container.querySelector('[data-pick-error]') as HTMLElement;
      const confirm = (): void => {
        if (!input.value) {
          errorEl.textContent = 'Please select a date.';
          errorEl.style.display = 'block';
          return;
        }
        const picked = new Date(input.value + 'T12:00:00');
        if (options.max && picked > options.max) {
          errorEl.textContent = 'Date is out of range.';
          errorEl.style.display = 'block';
          return;
        }
        resolved = true;
        modalService.hide();
        resolve(picked);
      };
      container.querySelector('[data-pick-cancel]')?.addEventListener('click', () => {
        resolved = true;
        modalService.hide();
        resolve(null);
      });
      container.querySelector('[data-pick-confirm]')?.addEventListener('click', confirm);
      input?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          confirm();
        }
      });
    }, 0);
  });
}

/**
 * Show a modal to pick a date range. Resolves with `{since, until}` as
 * Unix timestamps, or `null` if cancelled.
 */
export function pickDateRange(options: PickDateRangeOptions = {}): Promise<DateRangeResult | null> {
  const modalService = ModalService.getInstance();
  const title = options.title ?? 'Select Time Range';
  const confirmLabel = options.confirmLabel ?? 'Show Notes';
  const today = new Date();
  const defaultFrom = new Date();
  defaultFrom.setDate(today.getDate() - 3);

  const fromStr = formatDateForInput(options.initialFrom ?? defaultFrom);
  const toStr = formatDateForInput(options.initialTo ?? today);
  const todayStr = formatDateForInput(today);

  return new Promise((resolve) => {
    let resolved = false;
    const container = document.createElement('div');
    container.className = 'date-range-selector';
    container.innerHTML = `
      <div class="date-range-selector__fields">
        <label class="date-range-selector__field">
          <span class="date-range-selector__label">From</span>
          <input type="date" class="datepicker" data-range-from value="${fromStr}" max="${todayStr}" />
        </label>
        <label class="date-range-selector__field">
          <span class="date-range-selector__label">To</span>
          <input type="date" class="datepicker" data-range-to value="${toStr}" max="${todayStr}" />
        </label>
      </div>
      <div class="date-range-selector__error" data-range-error style="display: none;"></div>
      <div class="date-range-selector__actions">
        <button class="btn btn--secondary" data-range-cancel>Cancel</button>
        <button class="btn" data-range-confirm>${confirmLabel}</button>
      </div>
    `;

    modalService.show({
      title,
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

    setTimeout(() => {
      const fromInput = container.querySelector('[data-range-from]') as HTMLInputElement;
      const toInput = container.querySelector('[data-range-to]') as HTMLInputElement;
      const errorEl = container.querySelector('[data-range-error]') as HTMLElement;

      const showError = (msg: string): void => {
        errorEl.textContent = msg;
        errorEl.style.display = 'block';
      };

      const confirm = (): void => {
        const fromVal = fromInput?.value;
        const toVal = toInput?.value;
        if (!fromVal || !toVal) {
          showError('Please select both dates.');
          return;
        }
        const fromDate = new Date(fromVal + 'T00:00:00');
        const toDate = new Date(toVal + 'T23:59:59');
        const todayEnd = new Date();
        todayEnd.setHours(23, 59, 59, 999);

        if (fromDate > toDate) {
          showError('"From" date must be before "To" date.');
          return;
        }
        if (toDate > todayEnd) {
          showError('"To" date cannot be in the future.');
          return;
        }
        resolved = true;
        modalService.hide();
        resolve({
          since: Math.floor(fromDate.getTime() / 1000),
          until: Math.floor(toDate.getTime() / 1000)
        });
      };

      container.querySelector('[data-range-cancel]')?.addEventListener('click', () => {
        resolved = true;
        modalService.hide();
        resolve(null);
      });
      container.querySelector('[data-range-confirm]')?.addEventListener('click', confirm);

      const onEnter = (e: KeyboardEvent): void => {
        if (e.key === 'Enter') {
          e.preventDefault();
          confirm();
        }
      };
      fromInput?.addEventListener('keydown', onEnter);
      toInput?.addEventListener('keydown', onEnter);
    }, 0);
  });
}
