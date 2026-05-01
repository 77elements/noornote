/**
 * CursorRow — the single active "blank line" in the editor that accepts
 * either text input or a slash-menu block-type pick.
 *
 * Inspired by WordPress Gutenberg's empty-paragraph cursor:
 *   - Empty input with placeholder "Type / for block menu, or text…".
 *   - Plain text + Enter (or blur) → consumer creates a `text` block.
 *   - Type `/` at start → consumer-supplied "recent + all" block-type
 *     dropdown opens; further chars filter the list. Pick → consumer
 *     creates that block type.
 *
 * The CursorRow does NOT mutate the page itself. It only emits intent
 * via callbacks — `onTextEntered(text)` or `onBlockTypeChosen(type)`.
 * NospressView owns the page state, the cursor index, and the recent-used
 * tracking.
 */

import type { BlockType } from './types';
import { BLOCK_CATALOG, type BlockTypeMeta } from './blockCatalog';
import { escapeHtml, escapeHtmlAttr } from '../../../helpers/escapeHtml';

export interface CursorRowOptions {
  /** Plain text was entered + committed (Enter or blur with content). */
  onTextEntered: (text: string) => void;
  /** A block type was picked from the slash menu. */
  onBlockTypeChosen: (type: BlockType) => void;
  /** Recent block types in MRU order. Shown at the top of the slash menu. */
  getRecentBlockTypes: () => BlockType[];
}

const RECENT_LIMIT = 5;

export class CursorRow {
  private container: HTMLElement;
  private input!: HTMLInputElement;
  private menu!: HTMLDivElement;
  private opts: CursorRowOptions;
  private menuOpen = false;
  private menuFilter = '';
  private clickAwayHandler: (e: MouseEvent) => void;

  constructor(opts: CursorRowOptions) {
    this.opts = opts;
    this.container = document.createElement('div');
    this.container.className = 'nospress-cursor-row';
    this.container.innerHTML = `
      <input type="text" class="nospress-cursor-row__input" placeholder="Type / for block menu, or text to start writing…" autocomplete="off" spellcheck="false" />
      <div class="nospress-cursor-row__menu" hidden></div>
    `;
    this.input = this.container.querySelector('.nospress-cursor-row__input') as HTMLInputElement;
    this.menu = this.container.querySelector('.nospress-cursor-row__menu') as HTMLDivElement;
    this.clickAwayHandler = this.handleClickAway.bind(this);
    this.bindEvents();
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public focus(): void {
    this.input.focus();
  }

  public destroy(): void {
    document.removeEventListener('mousedown', this.clickAwayHandler, true);
    this.container.innerHTML = '';
  }

  private bindEvents(): void {
    this.input.addEventListener('input', () => this.handleInputChange());
    this.input.addEventListener('keydown', (e) => this.handleKeyDown(e));
    this.input.addEventListener('blur', () => this.handleBlur());
    this.menu.addEventListener('click', (e) => this.handleMenuClick(e));
    document.addEventListener('mousedown', this.clickAwayHandler, true);
  }

  private handleInputChange(): void {
    const value = this.input.value;
    if (value.startsWith('/')) {
      this.menuFilter = value.slice(1).toLowerCase().trim();
      this.openMenu();
    } else if (this.menuOpen) {
      this.closeMenu();
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      const value = this.input.value;
      if (this.menuOpen) {
        // Pick first visible menu item on Enter
        const firstItem = this.menu.querySelector<HTMLElement>('[data-block-type]');
        if (firstItem) firstItem.click();
        return;
      }
      const text = value.trim();
      if (text.length === 0) return;
      this.input.value = '';
      this.opts.onTextEntered(text);
    } else if (e.key === 'Escape' && this.menuOpen) {
      e.preventDefault();
      this.closeMenu();
      // Strip the leading slash so the row reverts to "plain text" mode
      this.input.value = '';
    }
  }

  private handleBlur(): void {
    // Defer so a click on the menu lands first
    setTimeout(() => {
      if (this.menuOpen) return;
      const text = this.input.value.trim();
      if (text.length === 0 || text.startsWith('/')) return;
      this.input.value = '';
      this.opts.onTextEntered(text);
    }, 150);
  }

  private handleClickAway(e: MouseEvent): void {
    if (!this.menuOpen) return;
    if (this.container.contains(e.target as Node)) return;
    this.closeMenu();
  }

  private openMenu(): void {
    this.menuOpen = true;
    this.menu.hidden = false;
    this.renderMenu();
  }

  private closeMenu(): void {
    this.menuOpen = false;
    this.menu.hidden = true;
    this.menu.innerHTML = '';
  }

  private renderMenu(): void {
    const enabled = BLOCK_CATALOG.filter(m => m.enabled);
    const recentTypes = this.opts.getRecentBlockTypes().slice(0, RECENT_LIMIT);
    const recent = recentTypes
      .map(t => enabled.find(m => m.type === t))
      .filter((m): m is BlockTypeMeta => !!m);
    const others = enabled.filter(m => !recent.includes(m));

    const filtered = (list: BlockTypeMeta[]) =>
      this.menuFilter
        ? list.filter(m =>
            m.label.toLowerCase().includes(this.menuFilter) ||
            m.type.toLowerCase().includes(this.menuFilter) ||
            m.description.toLowerCase().includes(this.menuFilter)
          )
        : list;

    const recentHtml = filtered(recent);
    const othersHtml = filtered(others);

    if (recentHtml.length === 0 && othersHtml.length === 0) {
      this.menu.innerHTML = `<div class="nospress-cursor-row__menu-empty">No matches for "${escapeHtml(this.menuFilter)}"</div>`;
      return;
    }

    const renderRow = (m: BlockTypeMeta) => `
      <button type="button" class="nospress-cursor-row__menu-item" data-block-type="${escapeHtmlAttr(m.type)}">
        <span class="nospress-cursor-row__menu-icon">${escapeHtml(m.icon)}</span>
        <span class="nospress-cursor-row__menu-label">${escapeHtml(m.label)}</span>
        <span class="nospress-cursor-row__menu-desc">${escapeHtml(m.description)}</span>
      </button>
    `;

    let html = '';
    if (recentHtml.length > 0) {
      html += `<div class="nospress-cursor-row__menu-section">Recent</div>`;
      html += recentHtml.map(renderRow).join('');
    }
    if (othersHtml.length > 0) {
      html += `<div class="nospress-cursor-row__menu-section">All blocks</div>`;
      html += othersHtml.map(renderRow).join('');
    }
    this.menu.innerHTML = html;
  }

  private handleMenuClick(e: Event): void {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-block-type]');
    if (!btn) return;
    const type = btn.dataset.blockType as BlockType;
    if (!type) return;
    this.input.value = '';
    this.closeMenu();
    this.opts.onBlockTypeChosen(type);
  }
}
