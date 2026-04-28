/**
 * MypageEditorView
 * Editor for the My Page custom list (freetext sections + items)
 *
 * Route: /profile/:npub/page/edit
 * "New Section" button, inline item adding, "Save" publishes to relays.
 *
 * @purpose Edit the custom list portion of My Page
 * @used-by ViewMountingService (route: mypage-edit)
 */

import { View } from '../../components/views/View';
import { AuthService } from '../../services/AuthService';
import { MypageOrchestrator } from '../../services/orchestration/MypageOrchestrator';
import { MypageService, type MypageListData, type MypageListSection } from '../../services/MypageService';
import { Router } from '../../services/Router';
import { ToastService } from '../../services/ToastService';
import { AuthGuard } from '../../services/AuthGuard';
import { decodeNip19 } from '../../services/NostrToolsAdapter';
import DOMPurify from 'dompurify';

export class MypageEditorView extends View {
  private container: HTMLElement;
  private npub: string;
  private pubkey: string;
  private sections: MypageListSection[] = [];

  constructor(npub: string) {
    super();
    this.npub = npub;
    this.container = document.createElement('div');
    this.container.className = 'view-content view-content--mypage-edit';

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
    if (!AuthGuard.requireAuth('edit My Page')) return;

    const currentUser = AuthService.getInstance().getCurrentUser();
    if (!currentUser || currentUser.pubkey !== this.pubkey) {
      this.container.innerHTML = '<p class="mypage-error">You can only edit your own page.</p>';
      return;
    }

    this.container.innerHTML = `
      <div class="mypage-loading">
        <div class="loading-spinner"></div>
        <p>Loading page...</p>
      </div>
    `;

    const listService = MypageService.getInstance();
    let existing = listService.getList();

    // Fall back to relays if local cache is empty (fresh device, post-rename, etc.)
    if (existing.sections.length === 0) {
      const fetched = await MypageOrchestrator.getInstance().fetchFromRelays(this.pubkey, false);
      if (fetched && fetched.sections.length > 0) {
        listService.setListFromRelay(fetched);
        existing = fetched;
      }
    }

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
      <div class="mypage-editor">
        <div class="l-spread">
          <h1>Edit your page</h1>
          <button class="btn btn--medium btn--passive" data-action="back">&larr; Back</button>
        </div>
        <div class="mypage-editor__header">
          <button class="btn btn--medium btn--primary" data-action="new-section">+ New Section</button>
        </div>
        <div class="mypage-editor__sections" data-sections></div>
        <div class="mypage-editor__footer">
          <button class="btn btn--medium btn--primary" data-action="save-list">Save Page</button>
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
        <div class="mypage-editor__empty">
          <p>No sections yet. Click "New Section" to get started.</p>
        </div>
      `;
      return;
    }

    this.sections.forEach((section, sectionIndex) => {
      const sectionEl = document.createElement('div');
      sectionEl.className = 'mypage-editor__section';
      sectionEl.dataset.sectionIndex = String(sectionIndex);

      const itemsHtml = section.items.map((item, itemIndex) => `
        <div class="mypage-editor__item" data-item-index="${itemIndex}">
          <span class="mypage-editor__item-text">${DOMPurify.sanitize(item)}</span>
          <button class="mypage-editor__item-delete" data-action="delete-item" data-section="${sectionIndex}" data-item="${itemIndex}" title="Remove">&times;</button>
        </div>
      `).join('');

      sectionEl.innerHTML = `
        <div class="mypage-editor__section-header">
          <h2 class="mypage-editor__section-title">${DOMPurify.sanitize(section.title)}</h2>
          <button class="mypage-editor__section-delete" data-action="delete-section" data-section="${sectionIndex}" title="Remove section">&times;</button>
        </div>
        <div class="mypage-editor__items">
          ${itemsHtml}
          <div class="mypage-editor__new-item-row">
            <input type="text" class="mypage-editor__new-item-input" placeholder="Add an entry..." data-section="${sectionIndex}" />
            <button class="mypage-editor__new-item-add" data-action="add-item" data-section="${sectionIndex}" title="Add">+</button>
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
      Router.getInstance().navigate(`/profile/${this.npub}/page`);
    });
  }

  private bindSectionEvents(): void {
    this.container.querySelectorAll('[data-action="delete-section"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt((e.currentTarget as HTMLElement).dataset.section!);
        this.sections.splice(index, 1);
        this.renderSections();
      });
    });

    this.container.querySelectorAll('[data-action="delete-item"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const el = e.currentTarget as HTMLElement;
        const sectionIndex = parseInt(el.dataset.section!);
        const itemIndex = parseInt(el.dataset.item!);
        this.sections[sectionIndex]!.items.splice(itemIndex, 1);
        this.renderSections();
      });
    });

    this.container.querySelectorAll('[data-action="add-item"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const sectionIndex = parseInt((e.currentTarget as HTMLElement).dataset.section!);
        this.addItemFromInput(sectionIndex);
      });
    });

    this.container.querySelectorAll('.mypage-editor__new-item-input').forEach(input => {
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

    const emptyEl = sectionsContainer.querySelector('.mypage-editor__empty');
    if (emptyEl) emptyEl.remove();

    const titleRow = document.createElement('div');
    titleRow.className = 'mypage-editor__new-section-row';
    titleRow.innerHTML = `
      <input type="text" class="mypage-editor__section-title-input" placeholder="Section title..." autofocus />
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

      const lastInput = this.container.querySelector(
        `[data-section="${this.sections.length - 1}"].mypage-editor__new-item-input`
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
      `.mypage-editor__new-item-input[data-section="${sectionIndex}"]`
    ) as HTMLInputElement | null;
    if (!input) return;

    const value = input.value.trim();
    if (!value) return;

    this.sections[sectionIndex]!.items.push(value);
    this.renderSections();

    const newInput = this.container.querySelector(
      `.mypage-editor__new-item-input[data-section="${sectionIndex}"]`
    ) as HTMLInputElement | null;
    newInput?.focus();
  }

  private async saveList(): Promise<void> {
    const cleanSections = this.sections.filter(s => s.items.length > 0);

    if (cleanSections.length === 0) {
      ToastService.show('Add at least one item before saving', 'error');
      return;
    }

    const listData: MypageListData = {
      version: 1,
      sections: cleanSections
    };

    try {
      const saveBtn = this.container.querySelector('[data-action="save-list"]') as HTMLButtonElement;
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
      }

      MypageService.getInstance().saveList(listData);
      await MypageOrchestrator.getInstance().publishToRelays();

      ToastService.show('Page saved', 'success');
      Router.getInstance().navigate(`/profile/${this.npub}/page`);
    } catch (error) {
      console.error('Failed to save page:', error);
      ToastService.show('Failed to save page', 'error');

      const saveBtn = this.container.querySelector('[data-action="save-list"]') as HTMLButtonElement;
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Page';
      }
    }
  }
}
