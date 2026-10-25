/**
 * TranslationPreviewModal — WP13 workbench. Load a .po file into the running
 * app for the current session (nothing persisted; a reload resets).
 * Opened by typing "i18n" outside form fields (translationPreview.ts).
 */

import { ModalService } from '../../services/ModalService';
import { ToastService } from '../../services/ToastService';
import { _ } from '../../i18n';
import { applyPreview } from '../../i18n/translationPreview';
import { parsePo, type PoParseResult } from '../../i18n/poParser';

export class TranslationPreviewModal {
  private modalService = ModalService.getInstance();
  private parsed: PoParseResult | null = null;

  public show(): void {
    const content = document.createElement('div');
    content.className = 'translation-preview-modal';
    content.innerHTML = `
      <p class="form__note">
        ${_('Load a .po file to see your translations in the running app. Nothing is saved — reloading the app resets to your saved language.')}
      </p>
      <div class="form__row">
        <label for="i18n-preview-file">${_('PO file')}</label>
        <input type="file" id="i18n-preview-file" accept=".po,text/plain">
      </div>
      <p id="i18n-preview-status" class="translation-preview-modal__status"></p>
      <button type="button" class="btn" id="i18n-preview-apply" disabled>
        ${_('Apply to this session')}
      </button>
    `;

    this.modalService.show({
      title: _('Translation Preview'),
      content,
      width: '460px',
      showCloseButton: true,
      closeOnOverlay: true,
      closeOnEsc: true,
    });

    setTimeout(() => this.setupHandlers(content), 0);
  }

  private setupHandlers(content: HTMLElement): void {
    const fileInput = content.querySelector(
      '#i18n-preview-file'
    ) as HTMLInputElement | null;
    const status = content.querySelector('#i18n-preview-status');
    const apply = content.querySelector(
      '#i18n-preview-apply'
    ) as HTMLButtonElement | null;
    if (!fileInput || !status || !apply) return;

    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      void file.text().then(text => {
        this.parsed = parsePo(text);
        if (this.parsed.stats.total === 0) {
          this.parsed = null;
          status.textContent = _('Not a valid .po file');
          apply.disabled = true;
          return;
        }
        status.textContent = this.describe(this.parsed);
        apply.disabled = false;
      });
    });

    apply.addEventListener('click', () => {
      if (!this.parsed) return;
      applyPreview(this.parsed);
      this.modalService.hide();
      ToastService.show(
        _('Applied for this session — reload the app to reset.'),
        'success'
      );
    });
  }

  private describe(parsed: PoParseResult): string {
    const { stats } = parsed;
    const lines = [
      `${_('Language:')} ${parsed.lang ?? '—'}`,
      _('%s of %s strings translated', stats.translated, stats.total),
    ];
    if (stats.fuzzy > 0)
      lines.push(_('%s fuzzy (preview shows them anyway)', stats.fuzzy));
    if (stats.untranslated > 0) {
      lines.push(_('%s untranslated (shown in English)', stats.untranslated));
    }
    return lines.join('\n');
  }
}
