/**
 * BlockLibraryView — catalog of available block types with [Apply] buttons.
 *
 * Mounted in the SCC "Block Library" tab on Desktop, in the Mobile-Overlay
 * lower-half on Phone. Identical content for both. No hover-only controls;
 * Apply buttons are always visible.
 *
 * Save / Discard / Publish controls live in the PCC action bar (NospressView)
 * so they remain reachable on Mobile, where the SCC isn't visible.
 */

import type { BlockType } from './types';
import { BLOCK_CATALOG } from './blockCatalog';
import { escapeHtml } from '../../../helpers/escapeHtml';

interface BlockLibraryViewOptions {
  onApply: (type: BlockType) => void;
  /** Click on the virtual "Page" entry at the top of the library — toggles
   *  the page-frame selection in the editor. No Apply button on that row. */
  onSelectPage: () => void;
}

export class BlockLibraryView {
  private container: HTMLElement;
  private opts: BlockLibraryViewOptions;

  constructor(opts: BlockLibraryViewOptions) {
    this.opts = opts;
    this.container = document.createElement('div');
    this.container.className = 'block-library';
    this.render();
    this.bindEvents();
  }

  public getElement(): HTMLElement {
    return this.container;
  }

  public destroy(): void {
    this.container.innerHTML = '';
  }

  private render(): void {
    // Virtual "Page" entry — the always-present page frame. Not a real block
    // type, no Apply button. Click toggles selection of the page frame in the
    // editor so the user can edit page-level properties.
    const pageRowHtml = `
      <div class="nn-card" data-action="select-page" role="button" tabindex="0">
        <div class="nn-card__content">
          <div class="icon" aria-hidden="true">▣</div>
          <h3>Page</h3>
        </div>
      </div>
    `;

    const rowsHtml = BLOCK_CATALOG.map(meta => `
      <div class="nn-card"${meta.enabled ? '' : ' data-disabled'} data-block-type="${meta.type}">
        <div class="nn-card__content">
          <div class="icon" aria-hidden="true">${escapeHtml(meta.icon)}</div>
          <h3>${escapeHtml(meta.label)}</h3>
          <div>
            <button
              type="button"
              class="btn btn--passive btn--mini"
              data-action="apply"
              data-block-type="${meta.type}"
              ${meta.enabled ? '' : 'disabled'}
            >${meta.enabled ? 'Apply' : 'Soon'}</button>
          </div>
        </div>
      </div>
    `).join('');

    this.container.innerHTML = `
      <div class="block-library__intro">
        <p>Click <strong>Apply</strong> to add a block to the end of your page.</p>
      </div>
      <div class="block-library__rows">${pageRowHtml}${rowsHtml}</div>
    `;
  }

  private bindEvents(): void {
    this.container.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      const pageRow = target.closest('[data-action="select-page"]');
      if (pageRow) {
        this.opts.onSelectPage();
        return;
      }

      const btn = target.closest('[data-action="apply"]') as HTMLButtonElement | null;
      if (!btn || btn.disabled) return;
      const type = btn.dataset.blockType as BlockType;
      if (type) this.opts.onApply(type);
    });
  }
}
