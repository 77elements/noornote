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
    const rowsHtml = BLOCK_CATALOG.map(meta => `
      <div class="block-library__row${meta.enabled ? '' : ' block-library__row--disabled'}" data-block-type="${meta.type}">
        <div class="block-library__icon" aria-hidden="true">${escapeHtml(meta.icon)}</div>
        <div class="block-library__info">
          <div class="block-library__label">${escapeHtml(meta.label)}</div>
          <div class="block-library__description">${escapeHtml(meta.description)}</div>
        </div>
        <button
          type="button"
          class="btn btn--passive btn--mini block-library__apply"
          data-action="apply"
          data-block-type="${meta.type}"
          ${meta.enabled ? '' : 'disabled'}
        >${meta.enabled ? 'Apply' : 'Soon'}</button>
      </div>
    `).join('');

    this.container.innerHTML = `
      <div class="block-library__intro">
        <p>Click <strong>Apply</strong> to add a block to the end of your page.</p>
      </div>
      <div class="block-library__rows">${rowsHtml}</div>
    `;
  }

  private bindEvents(): void {
    this.container.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-action="apply"]') as HTMLButtonElement | null;
      if (!btn || btn.disabled) return;
      const type = btn.dataset.blockType as BlockType;
      if (type) this.opts.onApply(type);
    });
  }
}
