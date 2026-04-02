/**
 * UpdateModal
 * Shows available update with release notes and download/skip/later actions
 * Tauri desktop only (guarded by UpdateCheckService.checkOnStartup)
 */

import { ModalService } from '../../services/ModalService';
import { PlatformService } from '../../services/PlatformService';
import { UpdateCheckService, type UpdateInfo } from '../../services/UpdateCheckService';
import { escapeHtml } from '../../helpers/escapeHtml';

declare const __APP_VERSION__: string;

/**
 * Render simple markdown to HTML.
 * Supports: lines starting with "# " / "## " → headings,
 * lines starting with "- " → list items, blank lines → spacing.
 */
function renderMarkdown(text: string): string {
  const lines = text.split('\n');
  let html = '';
  let inList = false;

  function closeList(): void {
    if (inList) { html += '</ul>'; inList = false; }
  }

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('# ')) {
      closeList();
      html += `<h3 style="margin: 0.75rem 0 0.25rem; font-size: 14px;">${escapeHtml(trimmed.slice(2))}</h3>`;
    } else if (trimmed.startsWith('## ')) {
      closeList();
      html += `<h4 style="margin: 0.75rem 0 0.25rem; font-size: 13px; opacity: 0.8;">${escapeHtml(trimmed.slice(3))}</h4>`;
    } else if (trimmed.startsWith('- ')) {
      if (!inList) { html += '<ul style="margin: 0.25rem 0; padding-left: 1.25rem;">'; inList = true; }
      html += `<li style="font-size: 13px; line-height: 1.5;">${escapeHtml(trimmed.slice(2))}</li>`;
    } else if (trimmed === '') {
      closeList();
    } else {
      closeList();
      html += `<p style="margin: 0.25rem 0; font-size: 13px; line-height: 1.5;">${escapeHtml(trimmed)}</p>`;
    }
  }

  closeList();
  return html;
}

export class UpdateModal {
  private modalService: ModalService;

  constructor() {
    this.modalService = ModalService.getInstance();
  }

  public show(update: UpdateInfo): void {
    const content = this.renderContent(update);

    this.modalService.show({
      title: 'Update Available',
      content,
      width: '480px',
      height: 'auto',
      showCloseButton: true,
      closeOnOverlay: true,
      closeOnEsc: true
    });

    setTimeout(() => this.setupEventHandlers(update), 0);
  }

  private renderContent(update: UpdateInfo): HTMLElement {
    const container = document.createElement('div');
    container.className = 'update-modal';

    const releaseDate = update.publishedAt
      ? new Date(update.publishedAt).toLocaleDateString()
      : '';

    container.innerHTML = `
      <div style="padding: 1rem;">
        <p style="margin-bottom: 1rem; text-align: center;">
          <strong>v${update.version}</strong> is available
          ${releaseDate ? `<span style="opacity: 0.6;"> (${releaseDate})</span>` : ''}
          <br>
          <span style="opacity: 0.6;">Current: v${__APP_VERSION__}</span>
        </p>

        ${update.releaseNotes ? `
          <div style="max-height: 50vh; overflow-y: auto; padding: 0.75rem; border-radius: 6px; background: var(--surface-tint); margin-bottom: 1.5rem;">
            ${renderMarkdown(update.releaseNotes)}
          </div>
        ` : ''}

        <div style="display: flex; gap: 0.75rem; justify-content: center;">
          <button class="btn btn--passive" id="update-skip-btn">Skip this version</button>
          <button class="btn btn--passive" id="update-later-btn">Later</button>
          <button class="btn" id="update-download-btn">Download</button>
        </div>
      </div>
    `;

    return container;
  }

  private setupEventHandlers(update: UpdateInfo): void {
    const downloadBtn = document.getElementById('update-download-btn');
    const laterBtn = document.getElementById('update-later-btn');
    const skipBtn = document.getElementById('update-skip-btn');

    downloadBtn?.addEventListener('click', async () => {
      try {
        const _p = PlatformService.getInstance();
        if (_p.isElectron) {
          await window.electronAPI!.openExternal(update.downloadUrl);
        } else if (_p.isTauri && !_p.isAndroid) {
          const { open } = await import('@tauri-apps/plugin-shell');
          await open(update.downloadUrl);
        } else {
          window.open(update.downloadUrl, '_blank', 'noopener,noreferrer');
        }
      } catch {
        // Best-effort: modal closes regardless
      }
      this.modalService.hide();
    });

    laterBtn?.addEventListener('click', () => {
      this.modalService.hide();
    });

    skipBtn?.addEventListener('click', () => {
      UpdateCheckService.getInstance().skipVersion(update.version);
      this.modalService.hide();
    });
  }

}
