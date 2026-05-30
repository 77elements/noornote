/**
 * NostrKeepView — the Keep board, mounted inline inside NostrKeepAddonView.
 *
 * Renders a "New note" action + a grid of note cards (pinned first). Cards open
 * the NoteEditorModal. Reads from KeepService (local IndexedDB); relay sync in 1d.
 */

import { View } from '../../components/views/View';
import { escapeHtml, escapeHtmlAttr } from '../../helpers/escapeHtml';
import { ToastService } from '../../services/ToastService';
import { KeepService } from './KeepService';
import { KeepSyncService } from './KeepSyncService';
import type { KeepNoteRecord } from './KeepStore';
import { NoteEditorModal } from './NoteEditorModal';

export class NostrKeepView extends View {
  private container: HTMLElement;
  /** Active label filter (null = all notes). */
  private activeLabel: string | null = null;

  constructor(_npub: string) {
    super();
    this.container = document.createElement('div');
    this.container.className = 'nostr-keep';
    this.container.innerHTML = `
      <div class="nostr-keep__toolbar l-spread">
        <button type="button" class="btn-icon" data-action="sync" title="Sync now" aria-label="Sync now">
          <svg width="18" height="18"><use href="#icon-sync"/></svg>
        </button>
        <button type="button" class="btn" data-action="new-note">
          <svg width="16" height="16"><use href="#icon-plus"/></svg>
          New note
        </button>
      </div>
      <div class="nostr-keep__filters" data-keep-filters></div>
      <div class="nostr-keep__board" data-keep-board></div>
    `;
    this.container.querySelector('[data-action="new-note"]')
      ?.addEventListener('click', () => this.openEditor());
    this.container.querySelector('[data-action="sync"]')
      ?.addEventListener('click', () => this.syncNow());

    void this.load().then(() => this.backgroundSync());
  }

  /** Pull from relays in the background, reload the board if anything changed. */
  private async backgroundSync(): Promise<void> {
    const changed = await KeepSyncService.getInstance().syncAll();
    if (changed) await this.load();
  }

  private async syncNow(): Promise<void> {
    await KeepSyncService.getInstance().syncAll();
    await this.load();
    ToastService.show('Notes synced', 'success');
  }

  /** Load notes from the store and (re)render the filters + board. */
  private async load(): Promise<void> {
    const board = this.container.querySelector('[data-keep-board]') as HTMLElement | null;
    if (!board) return;

    const allNotes = await KeepService.getInstance().listNotes();

    // Collect labels; drop the active filter if its label no longer exists.
    const labelSet = new Set<string>();
    allNotes.forEach((n) => n.labels.forEach((l) => labelSet.add(l)));
    if (this.activeLabel && !labelSet.has(this.activeLabel)) this.activeLabel = null;
    this.renderFilters(Array.from(labelSet).sort((a, b) => a.localeCompare(b)));

    const notes = this.activeLabel
      ? allNotes.filter((n) => n.labels.includes(this.activeLabel as string))
      : allNotes;

    if (notes.length === 0) {
      const msg = allNotes.length === 0
        ? { head: 'No notes yet', sub: 'Tap “New note” to write your first encrypted note.' }
        : { head: 'No notes with this label', sub: 'Pick another label or “All”.' };
      board.innerHTML = `
        <div class="nostr-keep__empty">
          <svg width="48" height="48"><use href="#icon-note"/></svg>
          <p>${msg.head}</p>
          <p class="text-alpha-medium">${msg.sub}</p>
        </div>
      `;
      return;
    }

    // Pinned first, each group already newest-updated first (from listNotes).
    const pinned = notes.filter((n) => n.pinned);
    const rest = notes.filter((n) => !n.pinned);
    const ordered = [...pinned, ...rest];

    board.innerHTML = `<div class="nostr-keep__grid">${ordered.map((n) => this.cardHtml(n)).join('')}</div>`;

    board.querySelectorAll('[data-note-id]').forEach((el) => {
      el.addEventListener('click', (e) => {
        const id = (el as HTMLElement).dataset.noteId!;
        const note = notes.find((n) => n.id === id);
        if (!note) return;

        // A click on a checklist item toggles it (don't open the editor).
        const item = (e.target as HTMLElement).closest('.keep-checklist-item') as HTMLElement | null;
        if (item) {
          e.preventDefault();  // stop the native label toggle; load() re-renders the true state
          e.stopPropagation();
          void this.toggleChecklistItem(note, Number(item.dataset.checkIndex));
          return;
        }
        this.openEditor(note);
      });
    });
  }

  /** Render the label filter chips ("All" + one per label). Hidden if no labels. */
  private renderFilters(labels: string[]): void {
    const el = this.container.querySelector('[data-keep-filters]') as HTMLElement | null;
    if (!el) return;
    if (labels.length === 0) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = `
      <button type="button" class="keep-filter${this.activeLabel === null ? ' is-active' : ''}" data-label="">All</button>
      ${labels.map((l) => `<button type="button" class="keep-filter${this.activeLabel === l ? ' is-active' : ''}" data-label="${escapeHtmlAttr(l)}">${escapeHtml(l)}</button>`).join('')}
    `;
    el.querySelectorAll('.keep-filter').forEach((btn) => {
      btn.addEventListener('click', () => {
        const label = (btn as HTMLElement).dataset.label || '';
        this.activeLabel = label === '' ? null : label;
        void this.load();
      });
    });
  }

  private cardHtml(note: KeepNoteRecord): string {
    const preview = note.body.length > 280 ? `${note.body.slice(0, 280)}…` : note.body;
    const MAX_ITEMS = 8;
    const checklist = note.checklist.length > 0 ? `
        <div class="keep-card__checklist">
          ${note.checklist.slice(0, MAX_ITEMS).map((item, i) => `
            <label class="nn-checkbox nn-checkbox--label-left keep-checklist-item${item.checked ? ' is-checked' : ''}" data-check-index="${i}">
              <span class="setting__label">${escapeHtml(item.text)}</span>
              <input type="checkbox"${item.checked ? ' checked' : ''} />
            </label>`).join('')}
          ${note.checklist.length > MAX_ITEMS ? `<div class="keep-card__checklist-more">+${note.checklist.length - MAX_ITEMS} more</div>` : ''}
        </div>` : '';
    const labels = note.labels.length > 0 ? `
        <div class="keep-card__labels">
          ${note.labels.map((l) => `<span class="keep-label">${escapeHtml(l)}</span>`).join('')}
        </div>` : '';
    return `
      <div class="keep-card${note.pinned ? ' keep-card--pinned' : ''}" data-note-id="${escapeHtml(note.id)}">
        ${note.pinned ? '<svg class="keep-card__pin" width="14" height="14"><use href="#icon-bookmark"/></svg>' : ''}
        ${note.title ? `<h2 class="keep-card__title h4">${escapeHtml(note.title)}</h2>` : ''}
        ${preview ? `<div class="keep-card__body">${escapeHtml(preview)}</div>` : ''}
        ${checklist}
        ${labels}
      </div>
    `;
  }

  private async toggleChecklistItem(note: KeepNoteRecord, index: number): Promise<void> {
    if (Number.isNaN(index) || index < 0 || index >= note.checklist.length) return;
    const checklist = note.checklist.map((it, i) => (i === index ? { ...it, checked: !it.checked } : it));
    await KeepService.getInstance().updateNote(note.id, { checklist });
    await this.load();
  }

  private openEditor(note?: KeepNoteRecord): void {
    new NoteEditorModal({
      ...(note ? { note } : {}),
      onChanged: () => { void this.load(); },
    }).open();
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.container.innerHTML = '';
  }
}
