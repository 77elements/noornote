/**
 * Modal-based date pickers.
 *
 * Three flavors:
 *   - `pickDate()`     — single date (e.g. NIP-23 `published_at` backdating)
 *   - `pickDateRange()` — from/to range (e.g. timeline "Select Time Range")
 *   - `pickDateTime()` — date + time with minute precision (e.g. scheduled posts)
 *
 * All return `null` on cancel. Promises resolve after the modal closes.
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

function formatTimeForInput(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
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

export interface PickDateTimeOptions {
  title?: string;
  /** Default: now + 1h. */
  initial?: Date;
  /** Hard lower bound (inclusive). Default: unset. */
  min?: Date;
  /** Hard upper bound (inclusive). Default: unset. */
  max?: Date;
  /** Label for the confirm button. Default: 'Schedule'. */
  confirmLabel?: string;
  /**
   * Element to anchor the popover to. The popover is positioned above/below
   * the anchor depending on available viewport space. If omitted, the popover
   * is centered in the viewport.
   */
  anchorEl?: HTMLElement;
}

/**
 * Show a date+time picker (minute precision) as a positioned popover. Uses a
 * standalone DOM element (no ModalService) so it can be opened from inside a
 * modal without destroying the parent. Closes on outside click or Escape.
 * Resolves with the chosen Date (seconds zeroed) or `null` if cancelled.
 */
export function pickDateTime(options: PickDateTimeOptions = {}): Promise<Date | null> {
  const confirmLabel = options.confirmLabel ?? 'Schedule';
  const initial = options.initial ?? new Date(Date.now() + 60 * 60 * 1000);
  const minAttrDate = options.min ? ` min="${formatDateForInput(options.min)}"` : '';
  const maxAttrDate = options.max ? ` max="${formatDateForInput(options.max)}"` : '';

  return new Promise((resolve) => {
    let resolved = false;
    const popover = document.createElement('div');
    popover.className = 'datetime-picker-popover';
    popover.innerHTML = `
      <div class="date-range-selector">
        <div class="date-range-selector__fields">
          <label class="date-range-selector__field">
            <span class="date-range-selector__label">Date</span>
            <input type="date" class="datepicker" data-pick-date value="${formatDateForInput(initial)}"${minAttrDate}${maxAttrDate} />
          </label>
          <label class="date-range-selector__field">
            <span class="date-range-selector__label">Time</span>
            <input type="time" class="datepicker" data-pick-time value="${formatTimeForInput(initial)}" />
          </label>
        </div>
        <div class="date-range-selector__error" data-pick-error style="display: none;"></div>
        <div class="date-range-selector__actions">
          <button class="btn btn--secondary" data-pick-cancel>Cancel</button>
          <button class="btn" data-pick-confirm>${confirmLabel}</button>
        </div>
      </div>
    `;
    document.body.appendChild(popover);

    // Position: anchored to trigger, or centered in viewport as fallback.
    if (options.anchorEl) {
      const rect = options.anchorEl.getBoundingClientRect();
      const popRect = popover.getBoundingClientRect();
      const margin = 8;
      // Prefer above the anchor; fall back to below if not enough space.
      const spaceAbove = rect.top;
      const placeAbove = spaceAbove >= popRect.height + margin;
      const top = placeAbove
        ? rect.top - popRect.height - margin
        : rect.bottom + margin;
      let left = rect.left;
      if (left + popRect.width > window.innerWidth - margin) {
        left = window.innerWidth - popRect.width - margin;
      }
      if (left < margin) left = margin;
      popover.style.top = `${Math.max(margin, top)}px`;
      popover.style.left = `${left}px`;
    } else {
      popover.style.top = '50%';
      popover.style.left = '50%';
      popover.style.transform = 'translate(-50%, -50%)';
    }

    const finish = (value: Date | null): void => {
      if (resolved) return;
      resolved = true;
      document.removeEventListener('keydown', onEsc);
      document.removeEventListener('mousedown', onOutside, true);
      popover.remove();
      resolve(value);
    };

    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish(null);
      }
    };
    const onOutside = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (popover.contains(target)) return;
      if (options.anchorEl && options.anchorEl.contains(target)) return;
      finish(null);
    };
    document.addEventListener('keydown', onEsc);
    // Delay outside-click handler to the next tick so the click that
    // opened the popover doesn't immediately close it.
    setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);

    const dateInput = popover.querySelector('[data-pick-date]') as HTMLInputElement;
    const timeInput = popover.querySelector('[data-pick-time]') as HTMLInputElement;
    const errorEl = popover.querySelector('[data-pick-error]') as HTMLElement;

    const showError = (msg: string): void => {
      errorEl.textContent = msg;
      errorEl.style.display = 'block';
    };

    const confirm = (): void => {
      const dVal = dateInput?.value;
      const tVal = timeInput?.value;
      if (!dVal || !tVal) {
        showError('Please select date and time.');
        return;
      }
      const picked = new Date(`${dVal}T${tVal}:00`);
      if (Number.isNaN(picked.getTime())) {
        showError('Invalid date or time.');
        return;
      }
      if (options.min && picked < options.min) {
        showError('Selected time is too early.');
        return;
      }
      if (options.max && picked > options.max) {
        showError('Selected time is too far in the future.');
        return;
      }
      picked.setSeconds(0, 0);
      finish(picked);
    };

    popover.querySelector('[data-pick-cancel]')?.addEventListener('click', () => finish(null));
    popover.querySelector('[data-pick-confirm]')?.addEventListener('click', confirm);

    const onEnter = (e: KeyboardEvent): void => {
      if (e.key === 'Enter') {
        e.preventDefault();
        confirm();
      }
    };
    dateInput?.addEventListener('keydown', onEnter);
    timeInput?.addEventListener('keydown', onEnter);
  });
}
