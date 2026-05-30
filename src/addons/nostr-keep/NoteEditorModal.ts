/**
 * NoteEditorModal - create/edit a Keep note in a modal.
 *
 * Title + Markdown body (shared MarkdownToolbar: heading/bold/italic/quote/image)
 * + pin toggle + delete. Saves via KeepService (local; relay sync in phase 1d).
 */

import { ModalService } from '../../services/ModalService';
import { ToastService } from '../../services/ToastService';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { MediaModuleApi } from '../../modules/media/contracts';
import { MarkdownToolbar } from '../../components/ui/MarkdownToolbar';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { KeepService } from './KeepService';
import type { KeepChecklistItem, KeepNoteRecord } from './KeepStore';
import { KEEP_COLORS } from './keepColors';

export interface NoteEditorOptions {
  /** Existing note to edit, or undefined for a new note. */
  note?: KeepNoteRecord;
  /** Called after a save or delete so the board can refresh. */
  onChanged: () => void;
}

export class NoteEditorModal {
  private toolbar: MarkdownToolbar | null = null;
  private pinned: boolean;
  private archived: boolean;
  private color: string;

  constructor(private readonly opts: NoteEditorOptions) {
    this.pinned = opts.note?.pinned ?? false;
    this.archived = opts.note?.archived ?? false;
    this.color = opts.note?.color ?? 'default';
  }

  public open(): void {
    const note = this.opts.note;
    const content = document.createElement('div');
    content.className = 'keep-editor';

    this.toolbar = new MarkdownToolbar({
      getTextarea: () => content.querySelector('.keep-editor__body') as HTMLTextAreaElement | null,
      onImageUpload: (file) => this.uploadImage(file),
    });

    content.innerHTML = `
      <input type="text" class="input keep-editor__title" placeholder="Title" value="${escapeHtmlAttr(note?.title ?? '')}" />
      ${this.toolbar.render()}
      <textarea class="textarea keep-editor__body" placeholder="Take a note…">${escapeHtml(note?.body ?? '')}</textarea>
      <div class="keep-editor__checklist" data-checklist></div>
      <button type="button" class="keep-editor__add-item" data-add-item>
        <svg width="14" height="14"><use href="#icon-plus"/></svg>
        List item
      </button>
      <div class="keep-editor__labels">
        <div class="keep-editor__label-chips" data-label-chips></div>
        <input type="text" class="input keep-editor__label-input" placeholder="Add label…" data-label-input />
      </div>
      <div class="keep-editor__colors" data-colors>
        ${KEEP_COLORS.map((c) => `<button type="button" class="keep-swatch keep-color-${c}${c === this.color ? ' is-active' : ''}" data-color="${c}" title="${c}" aria-label="${c} color"></button>`).join('')}
      </div>
      <div class="keep-editor__actions l-row--split">
        <div>
          <button type="button" class="btn-icon keep-editor__pin${this.pinned ? ' is-active' : ''}" title="Pin to top" aria-label="Pin to top">
            <svg width="18" height="18"><use href="#icon-bookmark"/></svg>
          </button>
          ${note ? `
          <button type="button" class="btn-icon keep-editor__archive${this.archived ? ' is-active' : ''}" title="${this.archived ? 'Unarchive' : 'Archive'}" aria-label="${this.archived ? 'Unarchive' : 'Archive'}">
            <svg width="18" height="18"><use href="#icon-folder"/></svg>
          </button>
          <button type="button" class="btn-icon keep-editor__delete" title="Delete note" aria-label="Delete note">
            <svg width="18" height="18"><use href="#icon-trash"/></svg>
          </button>` : ''}
        </div>
        <div>
          <button type="button" class="btn keep-editor__save">Save</button>
        </div>
      </div>
    `;

    const toolbarRoot = content.querySelector('.md-toolbar') as HTMLElement | null;
    if (toolbarRoot) this.toolbar.attach(toolbarRoot);

    const pinBtn = content.querySelector('.keep-editor__pin') as HTMLButtonElement;
    pinBtn.addEventListener('click', () => {
      this.pinned = !this.pinned;
      pinBtn.classList.toggle('is-active', this.pinned);
    });

    const archiveBtn = content.querySelector('.keep-editor__archive') as HTMLButtonElement | null;
    archiveBtn?.addEventListener('click', () => {
      this.archived = !this.archived;
      archiveBtn.classList.toggle('is-active', this.archived);
      const label = this.archived ? 'Unarchive' : 'Archive';
      archiveBtn.title = label;
      archiveBtn.setAttribute('aria-label', label);
    });

    // Checklist: render existing items, wire "Add item".
    const list = content.querySelector('[data-checklist]') as HTMLElement;
    (note?.checklist ?? []).forEach((item) => this.addChecklistRow(list, item));
    content.querySelector('[data-add-item]')?.addEventListener('click', () => {
      this.addChecklistRow(list, { text: '', checked: false }, true);
    });

    // Labels: render existing chips, add on Enter / comma.
    const chips = content.querySelector('[data-label-chips]') as HTMLElement;
    (note?.labels ?? []).forEach((label) => this.addLabelChip(chips, label));
    const labelInput = content.querySelector('[data-label-input]') as HTMLInputElement;
    labelInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const value = labelInput.value.trim().replace(/,+$/, '').trim();
        if (value) {
          this.addLabelChip(chips, value);
          labelInput.value = '';
        }
      }
    });

    // Color swatches: select one, highlight it.
    content.querySelectorAll('.keep-swatch').forEach((swatch) => {
      swatch.addEventListener('click', () => {
        this.color = (swatch as HTMLElement).dataset.color || 'default';
        content.querySelectorAll('.keep-swatch').forEach((s) =>
          s.classList.toggle('is-active', (s as HTMLElement).dataset.color === this.color));
      });
    });

    content.querySelector('.keep-editor__delete')?.addEventListener('click', () => this.handleDelete());
    content.querySelector('.keep-editor__save')?.addEventListener('click', () => this.handleSave(content));

    ModalService.getInstance().show({
      title: note ? 'Edit note' : 'New note',
      content,
      width: '600px',
      onClose: () => {
        this.toolbar?.destroy();
        this.toolbar = null;
      },
    });

    (content.querySelector('.keep-editor__title') as HTMLInputElement)?.focus();
  }

  /** Append a checklist row (checkbox + text + remove). */
  private addChecklistRow(list: HTMLElement, item: KeepChecklistItem, focus = false): void {
    const row = document.createElement('div');
    row.className = 'keep-checklist-row';
    row.innerHTML = `
      <input type="checkbox" class="keep-checklist-row__check"${item.checked ? ' checked' : ''} />
      <input type="text" class="input keep-checklist-row__text" placeholder="List item" value="${escapeHtmlAttr(item.text)}" />
      <button type="button" class="btn-icon keep-checklist-row__remove" aria-label="Remove item">
        <svg width="14" height="14"><use href="#icon-close"/></svg>
      </button>
    `;
    row.querySelector('.keep-checklist-row__remove')?.addEventListener('click', () => row.remove());
    list.appendChild(row);
    if (focus) (row.querySelector('.keep-checklist-row__text') as HTMLInputElement)?.focus();
  }

  /** Append a label chip (text + remove), de-duplicated. */
  private addLabelChip(container: HTMLElement, label: string): void {
    const existing = Array.from(container.querySelectorAll('.keep-label-chip__text')).map((e) => e.textContent);
    if (existing.includes(label)) return;
    const chip = document.createElement('span');
    chip.className = 'keep-label-chip';
    chip.innerHTML = `
      <span class="keep-label-chip__text">${escapeHtml(label)}</span>
      <button type="button" class="keep-label-chip__remove" aria-label="Remove label">
        <svg width="12" height="12"><use href="#icon-close"/></svg>
      </button>
    `;
    chip.querySelector('.keep-label-chip__remove')?.addEventListener('click', () => chip.remove());
    container.appendChild(chip);
  }

  private collectLabels(content: HTMLElement): string[] {
    return Array.from(content.querySelectorAll('.keep-label-chip__text'))
      .map((e) => (e.textContent || '').trim())
      .filter(Boolean);
  }

  /** Read checklist rows back into items, dropping blanks. */
  private collectChecklist(content: HTMLElement): KeepChecklistItem[] {
    return Array.from(content.querySelectorAll('.keep-checklist-row'))
      .map((row) => ({
        text: (row.querySelector('.keep-checklist-row__text') as HTMLInputElement).value.trim(),
        checked: (row.querySelector('.keep-checklist-row__check') as HTMLInputElement).checked,
      }))
      .filter((item) => item.text.length > 0);
  }

  private async handleSave(content: HTMLElement): Promise<void> {
    const title = (content.querySelector('.keep-editor__title') as HTMLInputElement).value.trim();
    const body = (content.querySelector('.keep-editor__body') as HTMLTextAreaElement).value;
    const checklist = this.collectChecklist(content);
    const labels = this.collectLabels(content);

    // Discard genuinely empty notes instead of persisting blanks.
    if (!title && !body.trim() && checklist.length === 0) {
      ModalService.getInstance().hide();
      return;
    }

    const keep = KeepService.getInstance();
    if (this.opts.note) {
      await keep.updateNote(this.opts.note.id, { title, body, pinned: this.pinned, archived: this.archived, color: this.color, checklist, labels });
    } else {
      await keep.createNote({ title, body, pinned: this.pinned, archived: this.archived, color: this.color, checklist, labels });
    }

    ModalService.getInstance().hide();
    this.opts.onChanged();
    ToastService.show('Note saved', 'success');
  }

  private async handleDelete(): Promise<void> {
    if (!this.opts.note) return;
    const confirmed = await ModalService.getInstance().confirm({
      title: 'Delete note',
      message: 'Delete this note? This removes it from this device.',
      confirmText: 'Delete',
      cancelText: 'Cancel',
      confirmDestructive: true,
    });
    if (!confirmed) return;

    await KeepService.getInstance().deleteNote(this.opts.note.id);
    ModalService.getInstance().hide();
    this.opts.onChanged();
    ToastService.show('Note deleted', 'success');
  }

  private async uploadImage(file: File): Promise<string | null> {
    const media = ModuleLoader.getInstance().getApi<MediaModuleApi>('media');
    const result = await media?.uploadFile(file);
    return result?.success && result.url ? result.url : null;
  }
}
