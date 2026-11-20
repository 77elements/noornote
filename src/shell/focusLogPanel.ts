/**
 * Focus log panel (v2) — the FV ED-b content when opened via its tab:
 * ONE continuous system-log stream (the classic panel's global/page
 * split is flattened — global entries persist, the current view's local
 * entries keep the v1 semantics: view-filtered, cleared on navigation)
 * plus the Export DiagLogs button (DiagLogExportService drives the full
 * export UX, v1 parity). Mounted by the stage when the ED-b opens via
 * its tab in a focused view.
 */

import { SystemLogger, type LogEntry } from '../services/SystemLogger';
import { escapeHtml } from '../helpers/escapeHtml';
import { _ } from '../i18n';

/** How many tail entries to render — DOM economy (full in-memory cap: 5000). */
const MAX_RENDERED = 150;

export class FocusLogPanel {
  /** Change subscription (mount → destroy contract). */
  private onEntries: (() => void) | null = null;
  private el: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;

  mount(el: HTMLElement): void {
    this.el = el;
    const logger = SystemLogger.getInstance();
    el.innerHTML = `
      <div class="focus-log-panel">
        <div class="focus-log-panel__head">
          <h4 class="focus-log-panel__heading">${_('System Logs')}</h4>
          <button type="button" class="focus-log-panel__export" data-log-export aria-label="${_('Export DiagLogs')}">${_('Export DiagLogs')}</button>
        </div>
        <div class="focus-log-panel__list" data-log-list></div>
      </div>
    `;
    this.listEl = el.querySelector('[data-log-list]') as HTMLElement;
    el.querySelector('[data-log-export]')?.addEventListener(
      'click',
      this.onExport
    );
    if (logger.isInMemorySuppressed()) {
      // Capacitor: no in-memory collection — logs live in files only.
      this.listEl.innerHTML = `<p class="focus-log-panel__empty">${_('Logs are stored in files on this device, use the export button.')}</p>`;
      return;
    }
    this.render();
    this.onEntries = () => this.render();
    logger.setOnEntriesChanged(this.onEntries);
  }

  private onExport = async (): Promise<void> => {
    const btn = this.el?.querySelector<HTMLButtonElement>('[data-log-export]');
    if (!btn) return;
    const { runDiagLogExportFromButton } = await import(
      '../services/DiagLogExportService'
    );
    await runDiagLogExportFromButton(btn, _('Export DiagLogs'));
  };

  private render(): void {
    if (!this.listEl) return;
    const el = this.listEl;
    // Pin to the bottom only when the user is already there (v1
    // auto-scroll feel without hijacking an upward scroll).
    const wasAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    const entries = SystemLogger.getInstance().getFlatEntries();
    const tail = entries.slice(-MAX_RENDERED);
    const olderCount = entries.length - tail.length;
    const parts: string[] = [];
    if (olderCount > 0) {
      parts.push(`<div class="focus-log-panel__older">… +${olderCount}</div>`);
    }
    parts.push(
      `<table class="focus-log-panel__table"><tbody>${tail
        .map(entry => this.row(entry))
        .join('')}</tbody></table>`
    );
    el.innerHTML = parts.join('');
    if (wasAtBottom) el.scrollTop = el.scrollHeight;
  }

  private row(entry: LogEntry): string {
    const time = new Date(entry.timestamp || Date.now()).toLocaleTimeString(
      [],
      { hour12: false }
    );
    const count =
      entry.count && entry.count > 1
        ? `<span class="focus-log-panel__count">×${entry.count}</span>`
        : '';
    return `<tr class="focus-log-panel__row focus-log-panel__row--${entry.level}"><td class="focus-log-panel__time">${time}</td><td class="focus-log-panel__msg">${escapeHtml(entry.message)}${count}</td></tr>`;
  }

  destroy(): void {
    SystemLogger.getInstance().setOnEntriesChanged(null);
    this.onEntries = null;
    this.el
      ?.querySelector('[data-log-export]')
      ?.removeEventListener('click', this.onExport);
    this.el = null;
    this.listEl = null;
  }
}
