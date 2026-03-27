/**
 * NostrInListEditorView
 * Editor for professional list (NostrIn addon)
 *
 * Route: /profile/:npub/list/edit
 * Freetext sections with items. "New Section" button, inline item adding,
 * "Save List" button publishes to relays.
 *
 * @purpose Edit professional list
 * @used-by ViewMountingService (route: nostrin-list-edit)
 */

import { View } from '../../components/views/View';
import { AuthService } from '../../services/AuthService';
import { NostrInListOrchestrator } from '../../services/orchestration/NostrInListOrchestrator';
import { NostrInListService, type NostrInListData, type NostrInListSection } from '../../services/NostrInListService';
import { Router } from '../../services/Router';
import { ToastService } from '../../services/ToastService';
import { AuthGuard } from '../../services/AuthGuard';
import { decodeNip19 } from '../../services/NostrToolsAdapter';
import DOMPurify from 'dompurify';

export class NostrInListEditorView extends View {
  private container: HTMLElement;
  private npub: string;
  private pubkey: string;
  private sections: NostrInListSection[] = [];

  constructor(npub: string) {
    super();
    this.npub = npub;
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--nostrin-list-edit';

    try {
      const decoded = decodeNip19(npub);
      this.pubkey = decoded.type === 'npub'
        ? decoded.data as string
        : (decoded.data as { pubkey: string }).pubkey;
    } catch {
      this.pubkey = '';
    }

    this.init();
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.container.innerHTML = '';
  }

  private async init(): Promise<void> {
    if (!AuthGuard.requireAuth('edit professional list')) return;

    const currentUser = AuthService.getInstance().getCurrentUser();
    if (!currentUser || currentUser.pubkey !== this.pubkey) {
      this.container.innerHTML = '<p class="nostrin-list-error">You can only edit your own list.</p>';
      return;
    }

    // Load existing data
    const listService = NostrInListService.getInstance();
    const existing = listService.getList();
    if (existing.sections.length > 0) {
      this.sections = existing.sections.map(s => ({
        title: s.title,
        items: [...s.items]
      }));
    }

    this.render();
  }

  private render(): void {
    this.container.innerHTML = `
      <div class="nostrin-list-editor">
        <div class="heading-back-btn-container">
          <h1>Create your list</h1>
          <button class="btn btn--medium btn--passive" data-action="back">&larr; Back</button>
        </div>
        <div class="nostrin-list-editor__header">
          <button class="btn btn--medium btn--primary" data-action="new-section">+ New Section</button>
        </div>
        <div class="nostrin-list-editor__sections" data-sections></div>
        <div class="nostrin-list-editor__footer">
          <button class="btn btn--medium btn--primary" data-action="save-list">Save List</button>
        </div>
      </div>
    `;

    this.renderSections();
    this.bindHeaderEvents();
  }

  private renderSections(): void {
    const sectionsContainer = this.container.querySelector('[data-sections]')!;
    sectionsContainer.innerHTML = '';

    if (this.sections.length === 0) {
      sectionsContainer.innerHTML = `
        <div class="nostrin-list-editor__empty">
          <p>No sections yet. Click "New Section" to get started.</p>
        </div>
      `;
      return;
    }

    this.sections.forEach((section, sectionIndex) => {
      const sectionEl = document.createElement('div');
      sectionEl.className = 'nostrin-list-editor__section';
      sectionEl.dataset.sectionIndex = String(sectionIndex);

      const itemsHtml = section.items.map((item, itemIndex) => `
        <div class="nostrin-list-editor__item" data-item-index="${itemIndex}">
          <span class="nostrin-list-editor__item-text">${DOMPurify.sanitize(item)}</span>
          <button class="nostrin-list-editor__item-delete" data-action="delete-item" data-section="${sectionIndex}" data-item="${itemIndex}" title="Remove">&times;</button>
        </div>
      `).join('');

      sectionEl.innerHTML = `
        <div class="nostrin-list-editor__section-header">
          <h2 class="nostrin-list-editor__section-title">${DOMPurify.sanitize(section.title)}</h2>
          <button class="nostrin-list-editor__section-delete" data-action="delete-section" data-section="${sectionIndex}" title="Remove section">&times;</button>
        </div>
        <div class="nostrin-list-editor__items">
          ${itemsHtml}
          <div class="nostrin-list-editor__new-item-row">
            <input type="text" class="nostrin-list-editor__new-item-input" placeholder="Add an entry..." data-section="${sectionIndex}" />
            <button class="nostrin-list-editor__new-item-add" data-action="add-item" data-section="${sectionIndex}" title="Add">+</button>
          </div>
        </div>
      `;

      sectionsContainer.appendChild(sectionEl);
    });

    this.bindSectionEvents();
  }

  private bindHeaderEvents(): void {
    this.container.querySelector('[data-action="new-section"]')?.addEventListener('click', () => {
      this.addNewSection();
    });

    this.container.querySelector('[data-action="save-list"]')?.addEventListener('click', () => {
      this.saveList();
    });

    this.container.querySelector('[data-action="back"]')?.addEventListener('click', (e) => {
      e.preventDefault();
      Router.getInstance().navigate(`/profile/${this.npub}/list`);
    });
  }

  private bindSectionEvents(): void {
    // Delete section buttons
    this.container.querySelectorAll('[data-action="delete-section"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt((e.currentTarget as HTMLElement).dataset.section!);
        this.sections.splice(index, 1);
        this.renderSections();
      });
    });

    // Delete item buttons
    this.container.querySelectorAll('[data-action="delete-item"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const el = e.currentTarget as HTMLElement;
        const sectionIndex = parseInt(el.dataset.section!);
        const itemIndex = parseInt(el.dataset.item!);
        this.sections[sectionIndex]!.items.splice(itemIndex, 1);
        this.renderSections();
      });
    });

    // Add item buttons
    this.container.querySelectorAll('[data-action="add-item"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const sectionIndex = parseInt((e.currentTarget as HTMLElement).dataset.section!);
        this.addItemFromInput(sectionIndex);
      });
    });

    // Enter key on inputs
    this.container.querySelectorAll('.nostrin-list-editor__new-item-input').forEach(input => {
      input.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') {
          e.preventDefault();
          const sectionIndex = parseInt((e.target as HTMLElement).dataset.section!);
          this.addItemFromInput(sectionIndex);
        }
      });
    });
  }

  private addNewSection(): void {
    const sectionsContainer = this.container.querySelector('[data-sections]')!;

    // Remove empty state if present
    const emptyEl = sectionsContainer.querySelector('.nostrin-list-editor__empty');
    if (emptyEl) emptyEl.remove();

    // Create inline title input
    const titleRow = document.createElement('div');
    titleRow.className = 'nostrin-list-editor__new-section-row';
    titleRow.innerHTML = `
      <input type="text" class="nostrin-list-editor__section-title-input" placeholder="Section title..." autofocus />
    `;
    sectionsContainer.appendChild(titleRow);

    const titleInput = titleRow.querySelector('input')!;
    titleInput.focus();

    let committed = false;
    const commitTitle = () => {
      if (committed) return;
      committed = true;

      const title = titleInput.value.trim();
      if (!title) {
        titleRow.remove();
        if (this.sections.length === 0) this.renderSections();
        return;
      }
      this.sections.push({ title, items: [] });
      this.renderSections();

      // Focus the new item input of the just-created section
      const lastInput = this.container.querySelector(
        `[data-section="${this.sections.length - 1}"].nostrin-list-editor__new-item-input`
      ) as HTMLInputElement | null;
      lastInput?.focus();
    };

    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitTitle();
      } else if (e.key === 'Escape') {
        committed = true;
        titleRow.remove();
        if (this.sections.length === 0) this.renderSections();
      }
    });

    titleInput.addEventListener('blur', () => {
      commitTitle();
    });
  }

  private addItemFromInput(sectionIndex: number): void {
    const input = this.container.querySelector(
      `.nostrin-list-editor__new-item-input[data-section="${sectionIndex}"]`
    ) as HTMLInputElement | null;
    if (!input) return;

    const value = input.value.trim();
    if (!value) return;

    this.sections[sectionIndex]!.items.push(value);
    this.renderSections();

    // Focus the new input of the same section
    const newInput = this.container.querySelector(
      `.nostrin-list-editor__new-item-input[data-section="${sectionIndex}"]`
    ) as HTMLInputElement | null;
    newInput?.focus();
  }

  private async saveList(): Promise<void> {
    // Filter out empty sections
    const cleanSections = this.sections.filter(s => s.items.length > 0);

    if (cleanSections.length === 0) {
      ToastService.show('Add at least one item before saving', 'error');
      return;
    }

    const listData: NostrInListData = {
      version: 1,
      sections: cleanSections
    };

    try {
      const saveBtn = this.container.querySelector('[data-action="save-list"]') as HTMLButtonElement;
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
      }

      NostrInListService.getInstance().saveList(listData);
      await NostrInListOrchestrator.getInstance().publishToRelays();

      ToastService.show('List saved', 'success');
      Router.getInstance().navigate(`/profile/${this.npub}/list`);
    } catch (error) {
      console.error('Failed to save list:', error);
      ToastService.show('Failed to save list', 'error');

      const saveBtn = this.container.querySelector('[data-action="save-list"]') as HTMLButtonElement;
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save List';
      }
    }
  }
}
