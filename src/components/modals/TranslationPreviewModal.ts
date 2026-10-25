/**
 * TranslationPreviewModal — WP13 workbench. Load a .po file into the running
 * app for the current session (sessionStorage only; dies with the session,
 * survives reloads). Applying reloads the app so every view — including
 * cached singletons and the boot-rendered sidebar — picks up the catalog.
 * Opened by typing "i18n" outside form fields (translationPreview.ts).
 */

import { ModalService } from '../../services/ModalService';
import { ToastService } from '../../services/ToastService';
import { _ } from '../../i18n';
import {
  clearPoPreview,
  isPoPreviewActive,
  storePoPreview,
} from '../../i18n/translationPreview';
import { parsePo, type PoParseResult } from '../../i18n/poParser';

export class TranslationPreviewModal {
  private modalService = ModalService.getInstance();
  private poText: string | null = null;
  private parsed: PoParseResult | null = null;

  public show(): void {
    const content = document.createElement('div');
    content.className = 'translation-preview-modal';
    const previewActive = isPoPreviewActive();
    content.innerHTML = `
      <p class="form__note">
        ${_('Load a .po file to see your translations in the running app. The preview lasts for this app session (it survives reloads) and overrides your saved language until you remove it.')}
      </p>
      <div class="form__row">
        <label for="i18n-preview-file">${_('PO file')}</label>
        <input type="file" id="i18n-preview-file" accept=".po,text/plain">
      </div>
      <p id="i18n-preview-status" class="translation-preview-modal__status"></p>
      <button type="button" class="btn" id="i18n-preview-apply" disabled>
        ${_('Apply and reload')}
      </button>
      ${
        previewActive
          ? `<button type="button" class="btn btn--secondary" id="i18n-preview-remove">
              ${_('Remove loaded .po file')}
            </button>`
          : ''
      }
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
    const remove = content.querySelector(
      '#i18n-preview-remove'
    ) as HTMLButtonElement | null;
    if (!fileInput || !status || !apply) return;

    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      void file.text().then(text => {
        this.poText = text;
        this.parsed = parsePo(text);
        if (this.parsed.stats.total === 0) {
          this.poText = null;
          this.parsed = null;
          status.textContent = _('Not a valid .po file');
          apply.disabled = true;
          return;
        }
        status.textContent = this.describe(this.parsed);
        apply.disabled = false;
      });
    });

    // Store + reload: boot re-injects the catalog before anything renders.
    apply.addEventListener('click', () => {
      if (!this.poText) return;
      storePoPreview(this.poText);
      location.reload();
    });

    remove?.addEventListener('click', () => {
      clearPoPreview();
      location.reload();
    });

    // Surface an already-active preview so the translator knows the state.
    if (isPoPreviewActive()) {
      ToastService.show(
        _('A preview is active — it survives reloads.'),
        'info'
      );
    }
  }

  private describe(parsed: PoParseResult): string {
    const { stats } = parsed;
    const lines = [
      `${_('Language:')} ${parsed.lang ?? '—'}`,
      _('%s of %s strings translated', stats.translated, stats.total),
    ];
    if (stats.fuzzy > 0) {
      lines.push(_('%s fuzzy (preview shows them anyway)', stats.fuzzy));
    }
    if (stats.untranslated > 0) {
      lines.push(_('%s untranslated (shown in English)', stats.untranslated));
    }
    return lines.join('\n');
  }
}
