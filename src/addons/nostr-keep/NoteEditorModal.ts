/**
 * NoteEditorModal — create/edit a Keep note in a modal.
 *
 * Title + Markdown body (shared MarkdownToolbar: heading/bold/italic/quote/image)
 * + pin toggle + delete. Saves via KeepService (local; relay sync in phase 1d).
 */

import { ModalService } from '../../services/ModalService';
import { ToastService } from '../../services/ToastService';
import { ModuleLoader } from '../../core/ModuleLoader';
import type { MediaModuleApi } from '../../modules/media/contracts';
import { MarkdownToolbar } from '../../components/ui/MarkdownToolbar';
import { escapeHtml } from '../../helpers/escapeHtml';
import { KeepService } from './KeepService';
import type { KeepNoteRecord } from './KeepStore';

export interface NoteEditorOptions {
  /** Existing note to edit, or undefined for a new note. */
  note?: KeepNoteRecord;
  /** Called after a save or delete so the board can refresh. */
  onChanged: () => void;
}

export class NoteEditorModal {
  private toolbar: MarkdownToolbar | null = null;
  private pinned: boolean;

  constructor(private readonly opts: NoteEditorOptions) {
    this.pinned = opts.note?.pinned ?? false;
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
      <input type="text" class="input keep-editor__title" placeholder="Title" value="${escapeHtml(note?.title ?? '')}" />
      ${this.toolbar.render()}
      <textarea class="textarea textarea--large keep-editor__body" placeholder="Take a note…">${escapeHtml(note?.body ?? '')}</textarea>
      <div class="keep-editor__actions l-row--split">
        <div>
          <button type="button" class="btn-icon keep-editor__pin${this.pinned ? ' is-active' : ''}" title="Pin to top" aria-label="Pin to top">
            <svg width="18" height="18"><use href="#icon-bookmark"/></svg>
          </button>
          ${note ? `
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

  private async handleSave(content: HTMLElement): Promise<void> {
    const title = (content.querySelector('.keep-editor__title') as HTMLInputElement).value.trim();
    const body = (content.querySelector('.keep-editor__body') as HTMLTextAreaElement).value;

    // Discard genuinely empty notes instead of persisting blanks.
    if (!title && !body.trim()) {
      ModalService.getInstance().hide();
      return;
    }

    const keep = KeepService.getInstance();
    if (this.opts.note) {
      await keep.updateNote(this.opts.note.id, { title, body, pinned: this.pinned });
    } else {
      await keep.createNote({ title, body, pinned: this.pinned });
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
