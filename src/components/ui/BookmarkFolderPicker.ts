/**
 * BookmarkFolderPicker — shared dropdown for selecting an existing bookmark
 * folder by name. Used by:
 *   - NosPress's bookmark-folder block editor (mount existing folder)
 *   - (future) NewBookmarkModal "Save to" dropdown — refactor pending
 *
 * Stays read-only over BookmarkFolderService — we only LIST folders, never
 * mutate them from here. (Lists feature is protected; touching its internals
 * requires explicit user approval.)
 */

import { getBookmarkFolderService } from '../../lists/bookmarks';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';

export interface BookmarkFolderPickerOptions {
  /** Initially selected folder (by name). Empty/undefined = no selection. */
  selectedFolderName?: string;
  /** Show a "Root Level" empty option. Used by NewBookmarkModal. */
  includeRootLevel?: boolean;
  /** Show a "+ Create new folder..." option. Used by NewBookmarkModal. */
  includeCreateNew?: boolean;
  /** Label for the empty/root option. Default: "Root Level". */
  emptyOptionLabel?: string;
  /** Placeholder shown when no folders exist. Default: "(no folders yet)". */
  noFoldersPlaceholder?: string;
  /** Called when the user picks a folder. null = cleared / Root Level. */
  onChange: (folderName: string | null) => void;
  /** Called when the user picks "+ Create new folder...". Consumer triggers a
   *  flow to enter the name and call createFolder() — the picker itself does
   *  not write to BookmarkFolderService. */
  onCreateNewRequested?: () => void;
}

export class BookmarkFolderPicker {
  private container: HTMLElement;
  private opts: BookmarkFolderPickerOptions;

  constructor(opts: BookmarkFolderPickerOptions) {
    this.opts = opts;
    this.container = document.createElement('div');
    this.container.className = 'bookmark-folder-picker';
    this.render();
    this.bindEvents();
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.container.innerHTML = '';
  }

  /**
   * Re-fetch folders + re-render. Call after the consumer has triggered a
   * folder-list change (e.g. created a new folder via onCreateNewRequested).
   */
  public refresh(selectedFolderName?: string): void {
    if (selectedFolderName !== undefined) {
      this.opts.selectedFolderName = selectedFolderName;
    }
    this.render();
    this.bindEvents();
  }

  private render(): void {
    const folders = getBookmarkFolderService().getFolders();
    const opts = this.opts;
    const sel = opts.selectedFolderName;

    const optionRows: string[] = [];

    if (opts.includeRootLevel) {
      const label = opts.emptyOptionLabel ?? 'Root Level';
      const isSel = !sel ? ' selected' : '';
      optionRows.push(`<option value=""${isSel}>${escapeHtml(label)}</option>`);
    } else if (!sel) {
      // No initial selection and no Root-Level option — show a placeholder
      optionRows.push(`<option value="" disabled selected>${escapeHtml(opts.noFoldersPlaceholder ?? '— Select folder —')}</option>`);
    }

    if (folders.length === 0 && !opts.includeCreateNew) {
      optionRows.push(`<option value="" disabled>${escapeHtml(opts.noFoldersPlaceholder ?? '(no folders yet)')}</option>`);
    } else {
      folders.forEach(f => {
        const isSel = sel === f.name ? ' selected' : '';
        optionRows.push(`<option value="${escapeHtmlAttr(f.name)}"${isSel}>${escapeHtml(f.name)}</option>`);
      });
    }

    if (opts.includeCreateNew) {
      optionRows.push(`<option value="__new__">+ Create new folder...</option>`);
    }

    this.container.innerHTML = `<select class="input bookmark-folder-picker__select">${optionRows.join('')}</select>`;
  }

  private bindEvents(): void {
    const select = this.container.querySelector('select') as HTMLSelectElement | null;
    if (!select) return;
    select.addEventListener('change', () => {
      const value = select.value;
      if (value === '__new__') {
        this.opts.onCreateNewRequested?.();
      } else {
        this.opts.onChange(value || null);
      }
    });
  }
}
