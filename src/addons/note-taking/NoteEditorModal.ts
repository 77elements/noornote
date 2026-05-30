/**
 * NoteEditorModal - create/edit a note in a modal.
 *
 * Title + Markdown body (shared MarkdownToolbar: heading/bold/italic/quote/image)
 * + pin toggle + delete. Saves via NoteTakingService (local; relay sync in phase 1d).
 */

import { ModalService } from '../../services/ModalService';
import { ToastService } from '../../services/ToastService';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { MediaModuleApi } from '../../modules/media/contracts';
import { MarkdownToolbar } from '../../components/ui/MarkdownToolbar';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { NoteTakingService } from './NoteTakingService';
import type { NoteChecklistItem, NoteRecord } from './NoteTakingStore';
import { NOTE_COLORS } from './noteColors';

export interface NoteEditorOptions {
  /** Existing note to edit, or undefined for a new note. */
  note?: NoteRecord;
  /** Called after a save or delete so the board can refresh. */
  onChanged: () => void;
}

export class NoteEditorModal {
  private toolbar: MarkdownToolbar | null = null;
  private pinned: boolean;
  private archived: boolean;
  private color: string;
  private reminderAt: number;

  constructor(private readonly opts: NoteEditorOptions) {
    this.pinned = opts.note?.pinned ?? false;
    this.archived = opts.note?.archived ?? false;
    this.color = opts.note?.color ?? 'default';
    this.reminderAt = opts.note?.reminderAt ?? 0;
  }

  public open(): void {
    const note = this.opts.note;
    const content = document.createElement('div');
    content.className = 'note-taking-editor';

    this.toolbar = new MarkdownToolbar({
      getTextarea: () => content.querySelector('.note-taking-editor__body') as HTMLTextAreaElement | null,
      onImageUpload: (file) => this.uploadImage(file),
    });

    content.innerHTML = `
      <input type="text" class="input note-taking-editor__title" placeholder="Title" value="${escapeHtmlAttr(note?.title ?? '')}" />
      ${this.toolbar.render()}
      <textarea class="textarea note-taking-editor__body" placeholder="Take a note…">${escapeHtml(note?.body ?? '')}</textarea>
      <div class="note-taking-editor__checklist" data-checklist></div>
      <button type="button" class="note-taking-editor__add-item" data-add-item>
        <svg width="14" height="14"><use href="#icon-plus"/></svg>
        List item
      </button>
      <div class="note-taking-editor__labels">
        <div class="note-taking-editor__label-chips" data-label-chips></div>
        <input type="text" class="input note-taking-editor__label-input" placeholder="Add label…" data-label-input />
      </div>
      <div class="note-taking-editor__colors" data-colors>
        ${NOTE_COLORS.map((c) => `<button type="button" class="note-taking-swatch note-taking-color-${c}${c === this.color ? ' is-active' : ''}" data-color="${c}" title="${c}" aria-label="${c} color"></button>`).join('')}
      </div>
      <div class="note-taking-editor__reminder-hint" data-reminder-hint></div>
      <div class="note-taking-editor__actions l-row--split">
        <div>
          <button type="button" class="btn-icon note-taking-editor__pin${this.pinned ? ' is-active' : ''}" title="Pin to top" aria-label="Pin to top">
            <svg width="18" height="18"><use href="#icon-bookmark"/></svg>
          </button>
          <button type="button" class="btn-icon note-taking-editor__reminder${this.reminderAt ? ' is-active' : ''}" title="Set reminder" aria-label="Set reminder">
            <svg width="18" height="18"><use href="#icon-calendar"/></svg>
          </button>
          ${note ? `
          <button type="button" class="btn-icon note-taking-editor__archive${this.archived ? ' is-active' : ''}" title="${this.archived ? 'Unarchive' : 'Archive'}" aria-label="${this.archived ? 'Unarchive' : 'Archive'}">
            <svg width="18" height="18"><use href="#icon-folder"/></svg>
          </button>
          <button type="button" class="btn-icon note-taking-editor__delete" title="Delete note" aria-label="Delete note">
            <svg width="18" height="18"><use href="#icon-trash"/></svg>
          </button>` : ''}
        </div>
        <div>
          <button type="button" class="btn note-taking-editor__save">Save</button>
        </div>
      </div>
    `;

    const toolbarRoot = content.querySelector('.md-toolbar') as HTMLElement | null;
    if (toolbarRoot) this.toolbar.attach(toolbarRoot);

    const pinBtn = content.querySelector('.note-taking-editor__pin') as HTMLButtonElement;
    pinBtn.addEventListener('click', () => {
      this.pinned = !this.pinned;
      pinBtn.classList.toggle('is-active', this.pinned);
      pinBtn.blur(); // drop focus so .btn-icon:focus green doesn't mask the toggle state
    });

    const archiveBtn = content.querySelector('.note-taking-editor__archive') as HTMLButtonElement | null;
    archiveBtn?.addEventListener('click', () => {
      this.archived = !this.archived;
      archiveBtn.classList.toggle('is-active', this.archived);
      const label = this.archived ? 'Unarchive' : 'Archive';
      archiveBtn.title = label;
      archiveBtn.setAttribute('aria-label', label);
      archiveBtn.blur();
    });

    // Reminder: pick a date+time with the shared picker; show a hint with Clear.
    const reminderBtn = content.querySelector('.note-taking-editor__reminder') as HTMLButtonElement;
    reminderBtn.addEventListener('click', async () => {
      const { pickDateTime } = await import('../../helpers/datePickerModal');
      const picked = await pickDateTime({
        title: 'Set reminder',
        initial: this.reminderAt ? new Date(this.reminderAt * 1000) : new Date(Date.now() + 60 * 60 * 1000),
        min: new Date(Date.now() + 60 * 1000),
        confirmLabel: 'Set',
        anchorEl: reminderBtn,
      });
      reminderBtn.blur();
      if (!picked) return;
      this.reminderAt = Math.floor(picked.getTime() / 1000);
      this.renderReminderHint(content);
    });
    this.renderReminderHint(content);

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
    content.querySelectorAll('.note-taking-swatch').forEach((swatch) => {
      swatch.addEventListener('click', () => {
        this.color = (swatch as HTMLElement).dataset.color || 'default';
        content.querySelectorAll('.note-taking-swatch').forEach((s) =>
          s.classList.toggle('is-active', (s as HTMLElement).dataset.color === this.color));
      });
    });

    content.querySelector('.note-taking-editor__delete')?.addEventListener('click', () => this.handleDelete());
    content.querySelector('.note-taking-editor__save')?.addEventListener('click', () => this.handleSave(content));

    ModalService.getInstance().show({
      title: note ? 'Edit note' : 'New note',
      content,
      width: '600px',
      onClose: () => {
        this.toolbar?.destroy();
        this.toolbar = null;
      },
    });

    (content.querySelector('.note-taking-editor__title') as HTMLInputElement)?.focus();
  }

  /** Append a checklist row (checkbox + text + remove). */
  private addChecklistRow(list: HTMLElement, item: NoteChecklistItem, focus = false): void {
    const row = document.createElement('div');
    row.className = 'note-taking-checklist-row';
    row.innerHTML = `
      <input type="checkbox" class="note-taking-checklist-row__check"${item.checked ? ' checked' : ''} />
      <input type="text" class="input note-taking-checklist-row__text" placeholder="List item" value="${escapeHtmlAttr(item.text)}" />
      <button type="button" class="btn-icon note-taking-checklist-row__remove" aria-label="Remove item">
        <svg width="14" height="14"><use href="#icon-close"/></svg>
      </button>
    `;
    row.querySelector('.note-taking-checklist-row__remove')?.addEventListener('click', () => row.remove());
    list.appendChild(row);
    if (focus) (row.querySelector('.note-taking-checklist-row__text') as HTMLInputElement)?.focus();
  }

  /** Append a label chip (text + remove), de-duplicated. */
  private addLabelChip(container: HTMLElement, label: string): void {
    const existing = Array.from(container.querySelectorAll('.note-taking-label-chip__text')).map((e) => e.textContent);
    if (existing.includes(label)) return;
    const chip = document.createElement('span');
    chip.className = 'note-taking-label-chip';
    chip.innerHTML = `
      <span class="note-taking-label-chip__text">${escapeHtml(label)}</span>
      <button type="button" class="note-taking-label-chip__remove" aria-label="Remove label">
        <svg width="12" height="12"><use href="#icon-close"/></svg>
      </button>
    `;
    chip.querySelector('.note-taking-label-chip__remove')?.addEventListener('click', () => chip.remove());
    container.appendChild(chip);
  }

  private collectLabels(content: HTMLElement): string[] {
    return Array.from(content.querySelectorAll('.note-taking-label-chip__text'))
      .map((e) => (e.textContent || '').trim())
      .filter(Boolean);
  }

  /** Read checklist rows back into items, dropping blanks. */
  private collectChecklist(content: HTMLElement): NoteChecklistItem[] {
    return Array.from(content.querySelectorAll('.note-taking-checklist-row'))
      .map((row) => ({
        text: (row.querySelector('.note-taking-checklist-row__text') as HTMLInputElement).value.trim(),
        checked: (row.querySelector('.note-taking-checklist-row__check') as HTMLInputElement).checked,
      }))
      .filter((item) => item.text.length > 0);
  }

  /** Show "Reminder: <when>" + Clear when a reminder is set; sync the button state. */
  private renderReminderHint(content: HTMLElement): void {
    const hint = content.querySelector('[data-reminder-hint]') as HTMLElement | null;
    const btn = content.querySelector('.note-taking-editor__reminder') as HTMLButtonElement | null;
    if (!hint) return;
    btn?.classList.toggle('is-active', this.reminderAt > 0);
    if (!this.reminderAt) {
      hint.innerHTML = '';
      return;
    }
    const when = new Date(this.reminderAt * 1000).toLocaleString();
    hint.innerHTML = `
      <span>Reminder: ${escapeHtml(when)}</span>
      <button type="button" class="note-taking-editor__reminder-clear" data-reminder-clear>Clear</button>
    `;
    hint.querySelector('[data-reminder-clear]')?.addEventListener('click', () => {
      this.reminderAt = 0;
      this.renderReminderHint(content);
    });
  }

  private async handleSave(content: HTMLElement): Promise<void> {
    const title = (content.querySelector('.note-taking-editor__title') as HTMLInputElement).value.trim();
    const body = (content.querySelector('.note-taking-editor__body') as HTMLTextAreaElement).value;
    const checklist = this.collectChecklist(content);
    const labels = this.collectLabels(content);

    // Discard genuinely empty notes instead of persisting blanks.
    if (!title && !body.trim() && checklist.length === 0) {
      ModalService.getInstance().hide();
      return;
    }

    const service = NoteTakingService.getInstance();
    if (this.opts.note) {
      await service.updateNote(this.opts.note.id, { title, body, pinned: this.pinned, archived: this.archived, color: this.color, reminderAt: this.reminderAt, checklist, labels });
    } else {
      await service.createNote({ title, body, pinned: this.pinned, archived: this.archived, color: this.color, reminderAt: this.reminderAt, checklist, labels });
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

    await NoteTakingService.getInstance().deleteNote(this.opts.note.id);
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
